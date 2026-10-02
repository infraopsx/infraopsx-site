---
layout: ../../../layouts/ArticleLayout.astro
title: "Kubernetes v1.27 to v1.37: A kubeadm Cluster Upgrade Log"
description: "A 5-node kubeadm cluster upgrade from Kubernetes v1.27 to v1.37. Part 1 covers v1.27.0 to v1.27.16, including backup, etcd, drain failures, PDBs, and verification."
pubDate: "2026-10-02"
category: Kubernetes
tags:
  - Kubernetes
  - kubeadm
  - Upgrade
  - etcd
  - PodDisruptionBudget
enPath: "/blog/kubeadm-kubernetes-v1-27-to-v1-37-upgrade/"
zhPath: "/zh/blog/kubeadm-kubernetes-v1-27-to-v1-37-upgrade/"
---

This cluster has 1 control-plane node and 4 workers. It is not an HA control-plane cluster.

| Item | Environment |
| --- | --- |
| control-plane | 1 |
| workers | 4 |
| OS | Debian 12 |
| Kernel | 6.1.0-52-amd64 |
| Runtime | containerd 1.6.20 |
| Starting version | Kubernetes v1.27.0 |
| Kubernetes binaries | Manually managed under `/usr/local/bin` |

A three-control-plane HA cluster has a different control-plane upgrade sequence and different checks around etcd topology, load balancing, and control-plane availability. The control-plane operations in this article should not be copied mechanically into an HA cluster.

## Why the first target is v1.27.16

A Kubernetes version number can be read as:

~~~text
v1.27.16
  │  │  └─ patch: 16
  │  └──── minor: 27
  └─────── major: 1
~~~

The cluster starts at `v1.27.0`. Before moving to the next minor release, I first patched the 1.27 series to its final patch release, `v1.27.16`.

Kubernetes lists 1.27.16 as the final patch in the 1.27 series. kubeadm upgrades also do not support skipping minor releases, so the later path will move through 1.28, 1.29, and so on one minor release at a time.

~~~text
1.27.0
→ 1.27.16
→ 1.28.x
→ 1.29.x
→ ...
→ 1.37.x
~~~

This does not mean that 1.27.16 is mandatory before 1.28. I chose it as a clean checkpoint: finish the current minor series first, then cross the minor-version boundary.

References:

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch releases</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>

## Pre-upgrade checks

Start with the nodes:

~~~bash
kubectl get nodes -o wide
~~~

The cluster looked like this:

~~~text
NAME     STATUS   ROLES           AGE    VERSION   INTERNAL-IP    OS-IMAGE                         KERNEL-VERSION   CONTAINER-RUNTIME
master   Ready    control-plane   262d   v1.27.0   10.10.10.100   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node1    Ready    worker          262d   v1.27.0   10.10.10.101   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node2    Ready    worker          262d   v1.27.0   10.10.10.102   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node3    Ready    worker          262d   v1.27.0   10.10.10.103   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node4    Ready    worker          260d   v1.27.0   10.10.10.104   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
~~~

Then verify kubeadm, kubelet, and kubectl:

~~~bash
kubeadm version -o short
kubelet --version
kubectl version
~~~

Relevant output:

~~~text
v1.27.0
Kubernetes v1.27.0
Client Version: ... GitVersion:"v1.27.0" ...
Server Version: ... GitVersion:"v1.27.0" ...
~~~

Then confirm the binary paths actually used for this upgrade:

~~~bash
command -v kubeadm kubelet kubectl
systemctl cat kubelet
~~~

Relevant output:

~~~text
/usr/local/bin/kubeadm
/usr/local/bin/kubelet
/usr/local/bin/kubectl

[Service]
ExecStart=/usr/local/bin/kubelet
...
ExecStart=/usr/local/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
~~~

This only describes the state observed before the upgrade: all three binaries were under `/usr/local/bin`, and the kubelet systemd service started kubelet from that path. It does not assume how the cluster was originally installed. For this upgrade, the existing binaries were replaced in place.

API readiness was healthy before the upgrade:

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

Relevant output:

~~~text
[+]ping ok
[+]etcd ok
[+]etcd-readiness ok
...
readyz check passed
~~~

## Backup and etcd snapshot

Create a directory for this checkpoint and a snapshot filename:

~~~bash
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/k8s-upgrade-backup/${TS}-before-v1.27.16"
SNAP="etcd-before-v1.27.16-${TS}.db"

mkdir -p \
  "$BACKUP_DIR/logs" \
  "$BACKUP_DIR/etcd" \
  "$BACKUP_DIR/bin" \
  "$BACKUP_DIR/config"
~~~

The actual directory created in this run was:

~~~text
/root/k8s-upgrade-backup/20261002-155639-before-v1.27.16
~~~

Back up the current binaries and record their checksums:

~~~bash
cp -a /usr/local/bin/kubeadm "$BACKUP_DIR/bin/"
cp -a /usr/local/bin/kubelet "$BACKUP_DIR/bin/"
cp -a /usr/local/bin/kubectl "$BACKUP_DIR/bin/"

sha256sum \
  "$BACKUP_DIR/bin/kubeadm" \
  "$BACKUP_DIR/bin/kubelet" \
  "$BACKUP_DIR/bin/kubectl"
~~~

Save Kubernetes and kubelet configuration:

~~~bash
tar -C / \
  -czf "$BACKUP_DIR/etc-kubernetes.tar.gz" \
  etc/kubernetes

tar -C / \
  -czf "$BACKUP_DIR/kubelet-config.tar.gz" \
  lib/systemd/system/kubelet.service \
  usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf \
  var/lib/kubelet/config.yaml \
  var/lib/kubelet/kubeadm-flags.env
~~~

Before taking the snapshot, check etcd health:

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  endpoint health -w table
~~~

~~~text
+------------------------+--------+------------+-------+
|        ENDPOINT        | HEALTH |    TOOK    | ERROR |
+------------------------+--------+------------+-------+
| https://127.0.0.1:2379 |   true | 7.597329ms |       |
+------------------------+--------+------------+-------+
~~~

Create the snapshot:

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  snapshot save "/var/lib/etcd/$SNAP"
~~~

Relevant output:

~~~text
Snapshot saved at /var/lib/etcd/etcd-before-v1.27.16-20261002-155639.db
~~~

That `/var/lib/etcd/...` path is where the snapshot was first created. It was then copied into the checkpoint directory:

~~~bash
cp -a "/var/lib/etcd/$SNAP" "$BACKUP_DIR/etcd/"
~~~

The backup copy therefore ended up at:

~~~text
/root/k8s-upgrade-backup/20261002-155639-before-v1.27.16/etcd/etcd-before-v1.27.16-20261002-155639.db
~~~

Check the snapshot contents:

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl snapshot status "/var/lib/etcd/$SNAP" -w table
~~~

The image did not contain `etcdutl`, so this run fell back to `etcdctl snapshot status`:

~~~text
Deprecated: Use `etcdutl snapshot status` instead.

+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| 4d3d67ac | 38602084 |       1182 |      19 MB |
+----------+----------+------------+------------+
~~~

Finally, checksum the backup copy:

~~~bash
sha256sum "$BACKUP_DIR/etcd/$SNAP"
~~~

~~~text
128caa1e419caffa7ea030e850dfd3bfa01105e5622338bb6a27dc8ffd82f967  /root/k8s-upgrade-backup/20261002-155639-before-v1.27.16/etcd/etcd-before-v1.27.16-20261002-155639.db
~~~

## Update the kubeadm tool, then run the upgrade plan

This step updates only the kubeadm tool on the control-plane node. The cluster itself is still on v1.27.0.

The download command was not preserved in this batch of logs, so this article does not invent a curl or wget line after the fact. What the logs do preserve is the target version, SHA256 verification, and the binary path that was replaced.

Verification record:

~~~text
kubeadm-v1.27.16: OK
33622018f83515331ac70c2041eba5d814a6d78a40b8869f089ea502f63a1421  kubeadm-v1.27.16
~~~

After replacing `/usr/local/bin/kubeadm`, check both the local kubeadm version and the cluster version:

~~~bash
kubeadm version -o short
kubectl version
~~~

Relevant output:

~~~text
v1.27.16
...
Server Version: ... GitVersion:"v1.27.0" ...
~~~

These are two different things: kubeadm is now v1.27.16, but the Kubernetes control-plane is still v1.27.0 because `kubeadm upgrade apply` has not run yet.

Now the plan is meaningful:

~~~bash
kubeadm upgrade plan
~~~

It describes what the v1.27.16 kubeadm tool intends to change in the still-v1.27.0 cluster:

~~~text
COMPONENT                 CURRENT   TARGET
kube-apiserver            v1.27.0   v1.27.16
kube-controller-manager   v1.27.0   v1.27.16
kube-scheduler            v1.27.0   v1.27.16
kube-proxy                v1.27.0   v1.27.16
CoreDNS                   v1.10.1   v1.10.1
etcd                      3.5.7-0   3.5.12-0

COMPONENT   CURRENT       TARGET
kubelet     5 x v1.27.0   v1.27.16
~~~

Before replacing kubeadm, the old v1.27.0 binary had been used to query the target images:

~~~bash
kubeadm config images list \
  --kubernetes-version v1.27.16 \
  --image-repository registry.aliyuncs.com/google_containers
~~~

It fell back to the older etcd mapping:

~~~text
could not find officially supported version of etcd for Kubernetes v1.27.16,
falling back to the nearest etcd version (3.5.7-0)
...
registry.aliyuncs.com/google_containers/etcd:3.5.7-0
~~~

The target kubeadm's upgrade plan selected etcd `3.5.12-0`, so the later upgrade decisions used that plan.

## Upgrade the control-plane

First run a dry run:

~~~bash
kubeadm upgrade apply v1.27.16 --dry-run
~~~

Then apply the upgrade:

~~~bash
kubeadm upgrade apply v1.27.16 --yes
~~~

The important end of the output was:

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.27.16". Enjoy!

[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven't already done so.
kubeadm upgrade apply exit code: 0
~~~

At this point the control-plane static Pods and etcd were already on the target versions. The images showed:

~~~text
etcd-master                       registry.aliyuncs.com/google_containers/etcd:3.5.12-0
kube-apiserver-master             registry.aliyuncs.com/google_containers/kube-apiserver:v1.27.16
kube-controller-manager-master    registry.aliyuncs.com/google_containers/kube-controller-manager:v1.27.16
kube-scheduler-master             registry.aliyuncs.com/google_containers/kube-scheduler:v1.27.16
~~~

But the node versions were still unchanged:

~~~bash
kubectl get nodes
~~~

~~~text
NAME     STATUS   ROLES           AGE    VERSION
master   Ready    control-plane   262d   v1.27.0
node1    Ready    worker          262d   v1.27.0
node2    Ready    worker          262d   v1.27.0
node3    Ready    worker          262d   v1.27.0
node4    Ready    worker          260d   v1.27.0
~~~

The VERSION column in `kubectl get nodes` is the kubelet version, so it remains v1.27.0 until the kubelet is upgraded separately.

### Certificate renewal

Before the upgrade:

~~~bash
kubeadm certs check-expiration
~~~

Relevant rows:

~~~text
admin.conf                 Jan 13, 2027 05:58 UTC   102d
apiserver                  Jan 13, 2027 05:58 UTC   102d
apiserver-etcd-client      Jan 13, 2027 05:58 UTC   102d
...
scheduler.conf             Jan 13, 2027 05:58 UTC   102d
~~~

After `kubeadm upgrade apply`:

~~~bash
kubeadm certs check-expiration
~~~

~~~text
admin.conf                 Oct 02, 2027 08:24 UTC   364d
apiserver                  Oct 02, 2027 08:22 UTC   364d
apiserver-etcd-client      Oct 02, 2027 08:22 UTC   364d
...
scheduler.conf             Oct 02, 2027 08:23 UTC   364d
~~~

## Upgrade kubelet and workers

After the control-plane kubelet was updated to v1.27.16, the workers were handled one at a time:

~~~text
replace kubeadm / kubectl
→ kubeadm upgrade node
→ drain
→ replace kubelet
→ restart kubelet
→ verify
→ uncordon
~~~

The main work was around drain failures.

### node1: emptyDir and PDB

First attempt:

~~~bash
kubectl drain node1 --ignore-daemonsets --timeout=5m
~~~

It failed:

~~~text
node/node1 cordoned
cannot delete Pods with local storage (use --delete-emptydir-data to override):
  kube-system/metrics-server-...
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...

drain exit code: 1
~~~

After confirming that the local storage was disposable `emptyDir` data in this test cluster, I retried with `--delete-emptydir-data`.

The next blocker was the prometheus-adapter PDB:

~~~bash
kubectl -n monitoring get pdb prometheus-adapter -o wide
~~~

~~~text
NAME                 MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-adapter   1               N/A               0
~~~

prometheus-adapter had one replica with `minAvailable: 1`, so there was no voluntary disruption available. In this test environment I temporarily scaled it to two replicas, waited for the second replica to become Ready, and then drained the node.

The same type of blocker later appeared on node3 and node4 because replacement Pods moved onto nodes that had not yet been maintained.

### node2: Prometheus had no persistent storage

node2 was left until last because it hosted:

~~~text
prometheus-k8s-0
~~~

The PDB was:

~~~bash
kubectl -n monitoring get pdb prometheus-k8s -o wide
~~~

~~~text
NAME             MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-k8s   1               N/A               0
~~~

Storage checks:

~~~bash
kubectl -n monitoring get pvc
kubectl get storageclass
kubectl get pv
~~~

All returned:

~~~text
No resources found
~~~

The Pod volume showed:

~~~text
prometheus-k8s-db => emptyDir={}
~~~

So the Prometheus TSDB was not on persistent storage. This test cluster could accept losing the existing history during drain. I saved the original PDB, temporarily changed `minAvailable` from 1 to 0, drained node2, and restored the PDB afterward.

In a production cluster I would stop here and fix Prometheus persistence before draining the node.

## Final v1.27.16 state

After all nodes were done:

~~~bash
kubectl get nodes
~~~

~~~text
NAME     STATUS   ROLES           AGE    VERSION
master   Ready    control-plane   262d   v1.27.16
node1    Ready    worker          262d   v1.27.16
node2    Ready    worker          262d   v1.27.16
node3    Ready    worker          262d   v1.27.16
node4    Ready    worker          261d   v1.27.16
~~~

The next step is:

~~~text
v1.27.16 → v1.28.15
~~~

The later checkpoints will keep the same format: commands where they matter, cropped output that supports the decision, and only enough explanation to show why the next step was taken.

## References

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch releases</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain</a>
