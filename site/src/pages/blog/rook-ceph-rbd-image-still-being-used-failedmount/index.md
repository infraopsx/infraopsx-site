---
layout: ../../../layouts/ArticleLayout.astro
title: "Kubernetes + Rook Ceph: Troubleshooting FailedMount 'RBD image is still being used'"
description: "A practical Rook Ceph RBD troubleshooting guide for Kubernetes FailedMount errors: trace CSI node mappings, stale RBD watchers, blocklist fencing, safe unmap, and recovery verification."
pubDate: "2026-09-19"
category: Storage
tags:
  - Kubernetes
  - Rook
  - Ceph
  - RBD
  - CSI
  - Troubleshooting
enPath: "/blog/rook-ceph-rbd-image-still-being-used-failedmount/"
zhPath: "/zh/blog/rook-ceph-rbd-image-still-being-used-failedmount/"
---

I ran into this class of failure with a Pod stuck in `ContainerCreating` while `kubectl describe pod` repeatedly showed:

```text
Warning  FailedMount  kubelet

MountVolume.MountDevice failed for volume "pvc-xxxxxxxx":
rpc error: code = Internal desc =
rbd image ceph-blockpool/csi-vol-xxxxxxxx is still being used
```

My original recovery notes were simple:

```text
find where the RBD image is mapped
        ↓
make sure the old mount is no longer needed
        ↓
umount
        ↓
rbd unmap
        ↓
let CSI mount the volume again
```

That worked for the incident, but the more important lesson is:

> **`is still being used` is a data-safety signal. Find out who still owns the RBD client state before removing anything.**

Deleting `VolumeAttachment`, forcing an unmap, or blocklisting a client before understanding the old writer can turn a mount failure into a data-integrity problem.

> PVC names, RBD image IDs, node names, and addresses below are generic examples.

## What the error is protecting

RBD volumes are commonly used as Kubernetes `ReadWriteOnce` block storage.

During a clean Pod move:

```text
old Pod stops
        ↓
old node unmounts
        ↓
old node unmaps RBD
        ↓
CSI detaches
        ↓
new node maps RBD
        ↓
mount
        ↓
new Pod runs
```

After an unclean node loss, kubelet problem, network interruption, or incomplete CSI cleanup, Ceph or CSI may still see the previous client as using the image.

The new node is then prevented from taking the RBD image.

That protection exists to avoid two nodes writing the same RWO block device.

## Step 1: identify Pod, PVC, PV, and node

Start with the Pod:

```bash
kubectl -n app get pod app-0 -o wide
kubectl -n app describe pod app-0
```

Record:

```text
Pod
Node
PVC
RBD image from the FailedMount message
```

Inspect PVC and PV:

```bash
kubectl -n app get pvc data-app-0 -o wide
kubectl get pv <pv-name> -o yaml
```

Then inspect Kubernetes attachment state:

```bash
kubectl get volumeattachment
```

For a large cluster:

```bash
kubectl get volumeattachment -o yaml | grep -B5 -A10 '<pv-name>'
```

This answers:

```text
Which node does Kubernetes currently believe should own the attachment?
```

It does not prove that the lower-level RBD mapping is already gone.

## Step 2: locate the CSI RBD nodeplugin

`csi-rbdplugin` normally runs as a DaemonSet on nodes that can consume RBD volumes.

List the plugins:

```bash
kubectl -n rook-ceph get pod -o wide | grep csi-rbdplugin
```

Find the plugin on the application Pod's node and inspect its logs:

```bash
kubectl -n rook-ceph logs \
  csi-rbdplugin-xxxxx \
  -c csi-rbdplugin \
  --since=30m
```

If it repeatedly reports:

```text
is still being used
```

move down to the RBD layer.

## Step 3: scan nodeplugins for the mapping

The command I originally used was:

```bash
for pod in $(kubectl -n rook-ceph get pods \
  | grep rbdplugin \
  | grep -v provisioner \
  | awk '{print $1}'); do
    echo "===== $pod ====="
    kubectl -n rook-ceph exec "$pod" -c csi-rbdplugin -- rbd device list
done
```

Example:

```text
===== csi-rbdplugin-node-a =====
id  pool            namespace  image                  snap  device
0   ceph-blockpool             csi-vol-aaaa           -     /dev/rbd0
1   ceph-blockpool             csi-vol-bbbb           -     /dev/rbd1
```

Search for the target:

```text
csi-vol-xxxxxxxx
```

### Why the toolbox is not enough

RBD mappings exist on the Kubernetes node that actually consumes the volume.

Running:

```bash
rbd device list
```

inside `rook-ceph-tools` and seeing nothing does not prove the image is not mapped elsewhere.

Rook maintainers made the same point in the historical issue: unmap the image where it is actually mapped, not from an unrelated toolbox Pod.

# Case 1: the old mapping is found

Assume:

```text
ceph-blockpool/csi-vol-xxxxxxxx
→ /dev/rbd5
```

on `csi-rbdplugin-node-a`.

Enter that plugin:

```bash
kubectl -n rook-ceph exec -it \
  csi-rbdplugin-node-a \
  -c csi-rbdplugin -- sh
```

Check whether it is mounted:

```bash
findmnt /dev/rbd5
```

or:

```bash
mount | grep '/dev/rbd5'
```

Inspect the device:

```bash
lsblk /dev/rbd5
```

If available:

```bash
fuser -vm /dev/rbd5
```

The question is:

> Is the old workload really still using the block device, or is this only stale mapping state?

## Unmount only after the old workload is known to be stopped

If a mount remains:

```bash
umount <mount-point>
```

Do not start with lazy or forced unmount.

If normal `umount` fails, identify the process still holding the filesystem first.

## Unmap the RBD device

Use the device:

```bash
rbd device unmap /dev/rbd5
```

or the image spec:

```bash
rbd device unmap ceph-blockpool/csi-vol-xxxxxxxx
```

Older installations commonly use:

```bash
rbd unmap /dev/rbd5
```

Do not construct a path like:

```text
/dev/rbd5/ceph-blockpool/csi-vol-xxxxxxxx
```

`/dev/rbd5` is already the block device.

## Force unmap is a last resort

Ceph supports force unmap, for example:

```bash
rbd device unmap --options force /dev/rbd5
```

or on some versions:

```bash
rbd unmap -o force /dev/rbd5
```

Force unmap can detach a device that is still open and cause subsequent I/O requests to fail.

I would only consider it after confirming:

```text
the old workload is stopped
there is no legitimate writer
normal unmap is stuck on stale state
```

# Case 2: no nodeplugin mapping exists, but `rbd status` shows a watcher

This is the more interesting case.

Run:

```bash
rbd status ceph-blockpool/csi-vol-xxxxxxxx
```

For example:

```text
Watchers:
    watcher=192.0.2.21:0/123456789
    client.12345
    cookie=18446462598732840000
```

If every:

```bash
rbd device list
```

is clean but `rbd status` still shows a watcher, the likely problem is stale client state from an old or lost node.

Historical Rook issues contain this exact pattern.

## A watcher is not the same as `rbd lock ls`

You may also try:

```bash
rbd lock ls ceph-blockpool/csi-vol-xxxxxxxx
```

and get no output.

That does not prove the image has no client state.

An RBD watcher and an advisory RBD lock are not the same thing.

For this failure, `rbd status` is one of the key checks.

# Before blocklisting: prove the old client is no longer allowed to write

Suppose the watcher is:

```text
watcher=192.0.2.21:0/123456789
```

Do not blocklist it immediately.

First answer:

```text
What node/client owns this address?
Is the old Kubernetes node alive?
Could the old Pod or RBD mapping still be writing?
Was the node actually lost, or only temporarily disconnected?
```

Compare with:

```bash
kubectl get nodes -o wide
kubectl get pods -A -o wide
```

The dangerous situation is:

```text
old node is still alive
+
administrator assumes it is dead
+
new node receives the same RWO RBD
=
possible concurrent writers
```

Fencing is more important than making the replacement Pod start quickly.

# If the old client is safely fenced, blocklist may release the handoff

Rook documents blocklisting for node-loss scenarios.

On newer Ceph releases:

```bash
ceph osd blocklist add <client-address>
```

Using an exact watcher endpoint may look like:

```bash
ceph osd blocklist add 192.0.2.21:0/123456789
```

Some workflows blocklist by node IP instead. Follow the fencing method documented for the Rook/Ceph version in use.

The purpose is:

```text
deny the stale Ceph client
        ↓
fence the old writer
        ↓
allow the replacement client to take the RBD safely
```

It is not simply "delete the watcher".

## `blocklist` vs older `blacklist`

Command names changed across Ceph releases.

Pacific and later commonly use:

```bash
ceph osd blocklist add <address>
ceph osd blocklist ls
ceph osd blocklist rm <address>
```

Older versions may use:

```bash
ceph osd blacklist add <address>
ceph osd blacklist ls
ceph osd blacklist rm <address>
```

If `blocklist` is not recognized:

```bash
ceph -v
```

before assuming the cluster lacks fencing support.

## Do not immediately remove the blocklist

After:

```bash
ceph osd blocklist add ...
```

the replacement Pod may recover.

That does not automatically mean it is safe to remove the blocklist immediately.

First verify:

```text
the old node cannot return with the old mapping
the stale client is gone
the new Pod is stable
there is no dual-writer risk
```

For a lost node, a full fencing or power-cycle workflow is safer before allowing that node back into service.

Modern Rook also supports CSI fencing around Kubernetes `node.kubernetes.io/out-of-service` taints. On clusters that support it, follow the current Rook node-loss procedure rather than blindly copying old issue comments.

# Case 3: no mapping and no watcher

If:

```bash
rbd device list
```

does not show the image and:

```bash
rbd status ceph-blockpool/csi-vol-xxxxxxxx
```

returns:

```text
Watchers: none
```

stop treating this as a stale RBD client problem.

Look for a stuck CSI operation instead.

Rook's current CSI troubleshooting documentation recommends checking the affected nodeplugin for stale:

```text
rbd map
rbd unmap
mkfs
mount
umount
```

Enter the plugin:

```bash
kubectl -n rook-ceph exec -it \
  csi-rbdplugin-xxxxx \
  -c csi-rbdplugin -- sh
```

Then:

```bash
ps -ef | grep '[r]bd'
ps -ef | grep '[m]ount'
ps -ef | grep '[u]mount'
ps -ef | grep '[m]kfs'
```

Also inspect:

```bash
dmesg
```

and the CSI logs.

If the issue is isolated to stale nodeplugin state, restarting the `csi-rbdplugin` Pod on the affected node may help.

I would not restart every CSI Pod first.

# Why I do not start by deleting VolumeAttachment

It is tempting to run:

```bash
kubectl delete volumeattachment ...
```

because the problem looks like an attachment problem.

But that only changes Kubernetes/CSI control-plane state.

It does not safely remove:

```text
a real RBD mapping
a mounted filesystem
an old watcher
a lost node that can still write to Ceph
```

I now think of the problem in three layers:

```text
Kubernetes
Pod / Node / VolumeAttachment

CSI node
mount / RBD mapping / stale operation

Ceph
watcher / client fencing
```

Correlate the three before changing state.

# Why the original recovery worked

My original note scanned all RBD nodeplugins:

```bash
for pod in $(kubectl -n rook-ceph get pods \
  | grep rbdplugin \
  | grep -v provisioner \
  | awk '{print $1}'); do
    echo "$pod"
    kubectl -n rook-ceph exec "$pod" \
      -c csi-rbdplugin -- rbd device list
done
```

After finding the image, I entered the corresponding plugin and used:

```bash
mount | grep /dev/rbdX
umount <mount-point>
rbd unmap ceph-blockpool/csi-vol-xxxxxxxx
```

CSI could then map the image again and the Pod recovered.

That is a valid path when an old mapping really remains on a node.

It is not the universal answer to every `still being used` error.

Another common path is:

```text
no mapping
but a stale watcher still exists
```

and that is when:

```bash
rbd status <pool>/<image>
```

becomes the key diagnostic step.

# Why reboot may appear to fix it

One community incident had this sequence:

```text
stale watcher
        ↓
node reboot
        ↓
watcher disappears
        ↓
next mount proceeds
        ↓
filesystem check reports inconsistency
```

That is plausible because a hard node loss can leave both RBD client state and the filesystem journal without a clean shutdown.

A reboot may clear the old client.

It does not guarantee the filesystem is clean.

If the next failure becomes:

```text
fsck found errors
UNEXPECTED INCONSISTENCY
```

that is a different layer of recovery.

`blocklist` and `unmap` are no longer the tools to repair that filesystem.

# Recovery verification

## Pod

```bash
kubectl -n app get pod app-0 -o wide
```

Expect:

```text
Running
```

## Events

```bash
kubectl -n app describe pod app-0
```

There should be no new repeated:

```text
FailedMount
is still being used
```

## RBD mapping

On the replacement nodeplugin:

```bash
rbd device list
```

The target image should be mapped only where expected.

## Watcher

```bash
rbd status ceph-blockpool/csi-vol-xxxxxxxx
```

The stale client should be gone.

## VolumeAttachment

```bash
kubectl get volumeattachment
```

Attachment state should agree with the Pod's current node.

## Application I/O

Finally, test the application itself.

A stateful workload can have a `Running` container while still performing its own journal recovery or database repair.

# The troubleshooting order I use now

```text
FailedMount:
rbd image ... is still being used
        ↓
1. identify Pod / PVC / PV / Node
        ↓
2. inspect VolumeAttachment
        ↓
3. inspect the node's csi-rbdplugin logs
        ↓
4. scan nodeplugins with rbd device list
        ↓
   mapping found?
   ├─ yes
   │   ↓
   │  check mount and open processes
   │   ↓
   │  confirm old workload is stopped
   │   ↓
   │  umount → unmap
   │
   └─ no
       ↓
       rbd status <pool>/<image>
       ↓
       watcher present?
       ├─ yes
       │   ↓
       │  identify old client/node
       │   ↓
       │  make sure it is safely fenced
       │   ↓
       │  blocklist/fencing when appropriate
       │
       └─ no
           ↓
           inspect CSI stale operations
           map / unmap / mount / umount / mkfs
           ↓
           dmesg + csi-rbdplugin logs
```

This is much more useful than my original note:

```text
find image
umount
unmap
```

# Operations I do not use casually

```bash
rbd unmap -o force ...
```

is not the first step.

```bash
ceph osd blocklist add ...
```

is not something I run merely because a watcher exists.

```bash
ceph osd blocklist rm ...
```

is not automatically safe as soon as the new Pod starts.

```bash
kubectl delete volumeattachment ...
```

does not replace lower-level cleanup or fencing.

```bash
reboot <node>
```

is not the cheapest RBD recovery tool.

Any of these may be correct, but only after the failing layer is understood.

# Three things I keep from this incident

First:

> `rbd image is still being used` usually means CSI is refusing to hand an RWO volume to a new node while old client state may still exist. That is a safety feature, not simply "Ceph is broken".

Second:

> `rbd device list` shows local mappings; `rbd status` shows watchers. No local mapping does not imply no stale Ceph client exists.

Third:

> Blocklisting is fencing, not merely watcher cleanup. Use it only when the old client is no longer allowed to be a valid writer.

Once these three layers are separated:

```text
Kubernetes attachment
CSI node mapping
Ceph watcher
```

this FailedMount error becomes much easier to reason about.

## References

- Rook issue #4772 — FailedMount rbd image is still being used  
  https://github.com/rook/rook/issues/4772
- Rook issue #11372 — RBD image is still being used / stale watcher  
  https://github.com/rook/rook/issues/11372
- Rook issue #11201 — MountVolume.MountDevice and stale RBD state  
  https://github.com/rook/rook/issues/11201
- Rook — CSI Common Issues  
  https://github.com/rook/rook/blob/master/Documentation/Troubleshooting/ceph-csi-common-issues.md
- Rook — Block Storage / Node fencing  
  https://github.com/rook/rook/blob/master/Documentation/Storage-Configuration/Block-Storage-RBD/block-storage.md
- Ceph — RBD command reference  
  https://docs.ceph.com/en/latest/man/8/rbd/
