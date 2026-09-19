---
layout: ../../../layouts/ArticleLayout.astro
title: "CephFS HEALTH_WARN: Troubleshooting MDS_CLIENT_LATE_RELEASE and MDS_SLOW_REQUEST"
description: "A real CephFS HEALTH_WARN incident: identify a client that fails to release capabilities, validate its state, manually evict it when appropriate, and understand why client eviction is a fencing operation rather than a first-step fix."
pubDate: "2026-09-19"
category: Storage
tags:
  - Ceph
  - CephFS
  - MDS
  - Kubernetes
  - CSI
  - Troubleshooting
enPath: "/blog/cephfs-client-late-release-mds-slow-request/"
zhPath: "/zh/blog/cephfs-client-late-release-mds-slow-request/"
---

This was a small incident, but a useful one to keep.

During a routine Ceph check, the cluster had changed from `HEALTH_OK` to:

```text
cluster:
  health: HEALTH_WARN
          1 clients failing to respond to capability release
          1 MDSs report slow requests
```

All PGs were `active+clean`, the OSDs were `up/in`, and the CephFS volume itself still appeared healthy.

The warnings pointed instead to one CephFS client and the MDS.

Running:

```bash
ceph health detail
```

identified the client. After confirming that it was the client that needed to be removed, I manually evicted it:

```bash
ceph tell mds.<mds-name> client evict id=<client-id>
```

The cluster returned to:

```text
health: HEALTH_OK
```

The important lesson is not the `client evict` command itself.

> `MDS_CLIENT_LATE_RELEASE` and `MDS_SLOW_REQUEST` are symptoms. Identify why the client is not responding before deciding to evict it.

CephFS client eviction is not harmless. If a client has buffered I/O that has not been flushed, that data can be lost.

> Cluster IDs, hostnames, addresses, filesystem names, MDS daemon names, and client IDs below are anonymized.

# 1. Start with `ceph status`

The first output looked similar to:

```bash
ceph status
```

```text
cluster:
  health: HEALTH_WARN
          1 clients failing to respond to capability release
          1 MDSs report slow requests

services:
  mon: 3 daemons, quorum ...
  mgr: active, standbys: ...
  mds: 1/1 daemons up, 2 standby
  osd: 3 osds: 3 up, 3 in

data:
  volumes: 1/1 healthy
  pgs:     241 active+clean
```

The interesting part was:

```text
OSDs up/in
PGs active+clean
CephFS volume healthy
```

while cluster health was still:

```text
HEALTH_WARN
```

This was not the usual OSD-down or degraded-PG problem.

The warnings already pointed at:

```text
CephFS client
MDS requests
```

# 2. Use `ceph health detail` to identify the client

Next:

```bash
ceph health detail
```

showed:

```text
HEALTH_WARN
1 clients failing to respond to capability release;
1 MDSs report slow requests

[WRN] MDS_CLIENT_LATE_RELEASE:
1 clients failing to respond to capability release

mds.example-fs.mds-node-a(mds.0):
Client worker-node-a:csi-cephfs-node
failing to respond to capability release
client_id: 123456

[WRN] MDS_SLOW_REQUEST:
1 MDSs report slow requests

mds.example-fs.mds-node-a(mds.0):
3 slow requests are blocked > 30 secs
```

This gives three useful values:

```text
MDS daemon
Client name
Client ID
```

For example:

```text
MDS       = mds.example-fs.mds-node-a
Client    = worker-node-a:csi-cephfs-node
Client ID = 123456
```

I would not jump directly from here to `client evict`.

# 3. What `MDS_CLIENT_LATE_RELEASE` means

CephFS clients receive capabilities from the MDS.

A simplified view is:

```text
MDS
 ↓
grants metadata/inode capabilities
 ↓
client holds those capabilities
```

When the MDS needs a capability back, the client is asked to release it.

Normal behavior:

```text
MDS requests release
        ↓
client responds
        ↓
capability is returned
```

Failure path:

```text
MDS requests release
        ↓
client does not respond in time
        ↓
MDS_CLIENT_LATE_RELEASE
```

The Ceph documentation describes this warning as a client failing to respond promptly to a capability release request.

That does not automatically mean:

```text
the MDS itself is broken
```

Possible causes include:

```text
stuck client
overloaded host
network problem
kernel or CephFS client issue
lost node
CSI-side problem
```

The health message alone does not tell us which one occurred.

# 4. `MDS_SLOW_REQUEST` is not a root-cause diagnosis either

The same incident also showed:

```text
MDS_SLOW_REQUEST
3 slow requests are blocked > 30 secs
```

That means one or more metadata requests have not completed promptly.

Possible causes include:

```text
slow MDS
slow acknowledgement of RADOS journal writes
blocked client-related work
software problems
```

So:

```text
MDS_SLOW_REQUEST
```

does not automatically translate into:

```text
"restart the MDS"
```

In this incident, `MDS_CLIENT_LATE_RELEASE` and `MDS_SLOW_REQUEST` appeared together, and both disappeared after the problematic client was evicted.

That makes the client highly relevant to this incident.

It does not mean every `MDS_SLOW_REQUEST` should be fixed by evicting clients.

# 5. Inspect the client before eviction

Ceph's client-eviction documentation recommends inspecting the client list first.

Run:

```bash
ceph tell mds.<mds-name> client ls
```

For example:

```bash
ceph tell mds.example-fs.mds-node-a client ls
```

A client entry may contain:

```json
{
  "id": 123456,
  "state": "open",
  "inst": "client.123456 192.0.2.10:0/123456789",
  "client_metadata": {
    "hostname": "worker-node-a"
  }
}
```

Useful fields include:

```text
id
state
inst
hostname
mount point, when available
other client metadata
```

The goal is not just to obtain an ID.

The real question is:

> Who owns this client, and is it still performing legitimate work?

# 6. If the client comes from Kubernetes / Ceph CSI

In this incident the client name contained:

```text
csi-cephfs-node
```

which linked it to the Kubernetes CephFS CSI side.

I would correlate it with:

```bash
kubectl get nodes -o wide
```

and the CephFS CSI nodeplugins:

```bash
kubectl -n rook-ceph get pod -o wide | grep cephfs
```

Then inspect the plugin on the corresponding node.

Exact Pod names vary between Rook and CSI versions, so the name itself is not the important part.

What matters is establishing:

```text
Is the node online?
Is the CephFS CSI plugin healthy?
Is a workload still legitimately using the mount?
Did the node recently restart or lose network connectivity?
```

If the host is healthy and the workload is still actively writing to the filesystem, eviction should not be the first action.

# 7. When manual eviction is appropriate

Typical manual-eviction scenarios include:

```text
the client has died
the client is misbehaving
normal unmount is not possible
the administrator should not wait for the session to time out
```

Then:

```bash
ceph tell mds.<mds-name> client evict id=<client-id>
```

In the incident, the equivalent operation was:

```bash
ceph tell mds.example-fs.mds-node-a \
  client evict id=123456
```

After that:

```bash
ceph status
```

returned:

```text
health: HEALTH_OK
```

This confirms that the client session was directly related to the health warning.

# 8. Why `client evict` must be treated carefully

Manual CephFS eviction is not simply:

```text
delete a row from the MDS client list
```

With normal configuration, eviction prevents the client from continuing to communicate with the MDS and OSDs.

It is client fencing.

If the client still has:

```text
buffered writes
unflushed data
```

that data can be lost.

So I would not turn the incident into this runbook:

```text
MDS_CLIENT_LATE_RELEASE
        ↓
copy client ID
        ↓
client evict
```

The safer sequence is:

```text
late release detected
        ↓
identify the client
        ↓
identify the node
        ↓
check workload ownership
        ↓
can it be stopped/unmounted normally?
        ├─ yes → do the normal cleanup
        └─ no
             ↓
       confirm the client is failed or must be fenced
             ↓
         client evict
```

# 9. After eviction, use a fresh mount

Do not assume that an evicted client should continue using its old mount.

The normal recovery path is:

```text
unmount
        ↓
fresh mount
```

In Kubernetes, let:

```text
CSI / kubelet
```

perform the mount again instead of trying to revive an old, evicted client session manually.

Ceph also provides ways to remove a client from the OSD blocklist, but the documentation warns that doing so can risk data integrity and does not guarantee the old client will become healthy.

Therefore:

```bash
ceph osd blocklist rm ...
```

is not an automatic follow-up step after `client evict`.

# 10. Why did `MDS_SLOW_REQUEST` disappear too?

The incident contained both:

```text
MDS_CLIENT_LATE_RELEASE
+
MDS_SLOW_REQUEST
```

After eviction:

```text
HEALTH_WARN
        ↓
HEALTH_OK
```

A reasonable conclusion is that the problematic client was involved in the blocked metadata activity.

But the original notes do not prove why that client stopped releasing capabilities.

The incident did not preserve enough information such as:

```text
node system logs
CSI plugin logs
network state
kernel CephFS logs
MDS outstanding operations
```

So I would document only what is supported:

```text
problematic client identified
        ↓
client manually evicted after validation
        ↓
both MDS warnings cleared
        ↓
cluster returned to HEALTH_OK
```

I would not invent a deeper root cause.

# 11. What I would collect next time

The original workflow was essentially:

```text
ceph status
        ↓
ceph health detail
        ↓
client evict
```

If it happens again, I would add at least:

```bash
ceph tell mds.<mds-name> client ls
```

and preserve the target client's:

```text
hostname
client address
state
metadata
```

For `MDS_SLOW_REQUEST`, I would also inspect the MDS outstanding operations rather than relying only on the health summary.

That would help distinguish:

```text
a client-side stall
```

from:

```text
MDS or RADOS latency
```

# 12. Validate the recovery

First:

```bash
ceph status
```

Verify:

```text
HEALTH_OK
```

Then:

```bash
ceph health detail
```

Confirm that:

```text
MDS_CLIENT_LATE_RELEASE
MDS_SLOW_REQUEST
```

are no longer being reported.

In Kubernetes, also verify:

```bash
kubectl get nodes
kubectl get pods -A -o wide
```

and check that the application can still access CephFS correctly.

The final success criteria should not be only:

```text
Ceph HEALTH_OK
```

They should include:

```text
client remounted cleanly
application I/O works
no new MDS warnings appear
```

# 13. The troubleshooting order I use now

```text
ceph status
    ↓
HEALTH_WARN:
client failing to respond to capability release
    ↓
ceph health detail
    ↓
get MDS name + client ID
    ↓
ceph tell mds.<name> client ls
    ↓
identify client / hostname / node
    ↓
inspect node, CSI, and workload state
    ↓
is this still a legitimate client?
 ├─ yes
 │   ↓
 │  investigate client / network / MDS / RADOS
 │
 └─ no, or the client is failed and cannot be cleaned up normally
     ↓
     client evict
     ↓
     fresh mount
     ↓
     ceph status + application I/O validation
```

# Summary

Only one forceful command was needed in the original incident:

```bash
ceph tell mds.<mds-name> client evict id=<client-id>
```

But it should not be remembered as:

```text
the universal fix for CephFS MDS warnings
```

`MDS_CLIENT_LATE_RELEASE` tells us:

```text
a client is not releasing a capability promptly
```

`MDS_SLOW_REQUEST` tells us:

```text
one or more MDS requests have remained incomplete for too long
```

When they occur together, the reported client deserves close investigation.

But client identity and workload state should still be verified before eviction.

> **CephFS client eviction is a fencing operation, not simple session cleanup. If the client has unflushed buffered I/O, data can be lost.**

That is more important than remembering which command happened to make `HEALTH_WARN` disappear.

## References

- Ceph Documentation — CephFS Health Messages  
  https://docs.ceph.com/en/latest/cephfs/health-messages/
- Ceph Documentation — CephFS Client Eviction  
  https://docs.ceph.com/en/latest/cephfs/eviction/
