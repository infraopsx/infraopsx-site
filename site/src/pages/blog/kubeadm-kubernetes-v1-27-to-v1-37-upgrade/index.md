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
| Kubernetes binary path | `/usr/local/bin` |

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

1.27.16 is not a mandatory prerequisite for 1.28. I chose it so the 1.27 series was fully patched before moving to the next minor release.

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

Before the upgrade, all three binaries were under `/usr/local/bin`, and the kubelet systemd service started kubelet from that path. This upgrade therefore replaced the existing binaries in place.

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

Save the kubeadm/kubelet configuration, node state, and workload state:

~~~bash
kubectl -n kube-system get cm kubeadm-config -o yaml \
  > "$BACKUP_DIR/config/kubeadm-config.yaml"

kubectl -n kube-system get cm kubelet-config -o yaml \
  > "$BACKUP_DIR/config/kubelet-config.yaml" 2>/dev/null || true

kubectl get nodes -o yaml \
  > "$BACKUP_DIR/config/nodes.yaml"

kubectl get deploy,ds,sts -A -o yaml \
  > "$BACKUP_DIR/config/workloads.yaml"

kubectl get pv -o yaml \
  > "$BACKUP_DIR/config/pv.yaml"

kubectl get pvc -A -o yaml \
  > "$BACKUP_DIR/config/pvc.yaml"

kubectl get pods -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,POD:.metadata.name,IMAGE:.spec.containers[*].image' \
  > "$BACKUP_DIR/config/images-before.txt"
~~~

Back up the current binaries and record their checksums:

~~~bash
cp -a /usr/local/bin/kubeadm "$BACKUP_DIR/bin/"
cp -a /usr/local/bin/kubelet "$BACKUP_DIR/bin/"
cp -a /usr/local/bin/kubectl "$BACKUP_DIR/bin/"

sha256sum \
  "$BACKUP_DIR/bin/kubeadm" \
  "$BACKUP_DIR/bin/kubelet" \
  "$BACKUP_DIR/bin/kubectl" \
  | tee "$BACKUP_DIR/logs/02-old-binary-sha256.txt"
~~~

Archive `/etc/kubernetes` and the kubelet-related configuration as well:

~~~bash
tar -czf "$BACKUP_DIR/etc-kubernetes.tar.gz" \
  /etc/kubernetes

tar -czf "$BACKUP_DIR/kubelet-config.tar.gz" \
  /lib/systemd/system/kubelet.service \
  /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf \
  /var/lib/kubelet/config.yaml \
  /var/lib/kubelet/kubeadm-flags.env

tar -tzf "$BACKUP_DIR/kubelet-config.tar.gz" >/dev/null \
  && echo "OK: kubelet configuration archive verified"
~~~

Verification result:

~~~text
OK: kubelet configuration archive verified
~~~

Before taking the snapshot, check etcd endpoint status:

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  endpoint status -w table
~~~

etcd was 3.5.7 and the database was about 19 MB:

~~~text
+------------------------+---------+---------+-----------+------------+--------+
|        ENDPOINT        | VERSION | DB SIZE | IS LEADER | IS LEARNER | ERRORS |
+------------------------+---------+---------+-----------+------------+--------+
| https://127.0.0.1:2379 |   3.5.7 |   19 MB |      true |      false |        |
+------------------------+---------+---------+-----------+------------+--------+
~~~

Then check endpoint health:

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

Copy the snapshot into the checkpoint directory:

~~~bash
cp -a "/var/lib/etcd/$SNAP" "$BACKUP_DIR/etcd/"
~~~

Check the snapshot:

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl snapshot status "/var/lib/etcd/$SNAP" -w table
~~~

~~~text
Deprecated: Use `etcdutl snapshot status` instead.

+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| 4d3d67ac | 38602084 |       1182 |      19 MB |
+----------+----------+------------+------------+
~~~

After confirming both the temporary snapshot and backup copy existed, remove the temporary file from `/var/lib/etcd`:

~~~bash
ls -lh \
  "/var/lib/etcd/$SNAP" \
  "$BACKUP_DIR/etcd/$SNAP"

rm -f "/var/lib/etcd/$SNAP"
~~~

Finally, generate a SHA256 checksum list for the whole checkpoint so it can be verified later after copying the backup or before a restore:

~~~bash
(
  cd "$BACKUP_DIR"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > SHA256SUMS
)
~~~

## Update the kubeadm tool, then run the upgrade plan

This step updates only the kubeadm tool on the control-plane node. The cluster itself is still on v1.27.0.

Download the target kubeadm binary and its official SHA256 file:

~~~bash
TARGET=v1.27.16
ARCH=amd64

curl -L \
  "https://dl.k8s.io/release/${TARGET}/bin/linux/${ARCH}/kubeadm" \
  -o "/tmp/kubeadm-${TARGET}"

curl -L \
  "https://dl.k8s.io/release/${TARGET}/bin/linux/${ARCH}/kubeadm.sha256" \
  -o "/tmp/kubeadm-${TARGET}.sha256"

cd /tmp
EXPECTED="$(cat kubeadm-${TARGET}.sha256)"
echo "${EXPECTED}  kubeadm-${TARGET}" | sha256sum -c -
~~~

Verification result:

~~~text
kubeadm-v1.27.16: OK
~~~

Then replace kubeadm:

~~~bash
install -o root -g root -m 0755 \
  "/tmp/kubeadm-${TARGET}" \
  /usr/local/bin/kubeadm
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

After confirming that the local kubeadm binary is v1.27.16 while the cluster is still v1.27.0, generate the upgrade plan:

~~~bash
kubeadm upgrade plan "$TARGET"
~~~

The version information from the upgrade plan is summarized below:

| Component | Current | Target |
| --- | --- | --- |
| kube-apiserver | v1.27.0 | v1.27.16 |
| kube-controller-manager | v1.27.0 | v1.27.16 |
| kube-scheduler | v1.27.0 | v1.27.16 |
| kube-proxy | v1.27.0 | v1.27.16 |
| CoreDNS | v1.10.1 | v1.10.1 |
| etcd | 3.5.7-0 | 3.5.12-0 |
| kubelet | all 5 nodes on v1.27.0 | v1.27.16 (upgraded node by node later) |


## Upgrade the control-plane

The checkpoint already contains `$BACKUP_DIR/config/kubeadm-config.yaml`. Its ClusterConfiguration includes:

~~~yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
imageRepository: registry.aliyuncs.com/google_containers
kubernetesVersion: v1.27.0
~~~

Use the updated kubeadm v1.27.16 binary to list the images required for this upgrade:

~~~bash
kubeadm config images list \
  --kubernetes-version v1.27.16 \
  --image-repository registry.aliyuncs.com/google_containers
~~~

Output:

~~~text
registry.aliyuncs.com/google_containers/kube-apiserver:v1.27.16
registry.aliyuncs.com/google_containers/kube-controller-manager:v1.27.16
registry.aliyuncs.com/google_containers/kube-scheduler:v1.27.16
registry.aliyuncs.com/google_containers/kube-proxy:v1.27.16
registry.aliyuncs.com/google_containers/pause:3.9
registry.aliyuncs.com/google_containers/etcd:3.5.12-0
registry.aliyuncs.com/google_containers/coredns:v1.10.1
~~~

After checking the image list, pull the images:

~~~bash
kubeadm config images pull \
  --kubernetes-version v1.27.16 \
  --image-repository registry.aliyuncs.com/google_containers
~~~

First run a dry run:

~~~bash
kubeadm upgrade apply v1.27.16 --dry-run
~~~

The kubeadm dry-run output ended with:

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

Then apply the upgrade:

~~~bash
kubeadm upgrade apply v1.27.16 --yes
~~~

The beginning of the output shows kubeadm reading the cluster configuration:

~~~text
[upgrade/config] Reading configuration from the cluster...
[upgrade/version] You have chosen to change the cluster version to "v1.27.16"
[upgrade/versions] Cluster version: v1.27.0
[upgrade/versions] kubeadm version: v1.27.16
[upgrade/prepull] Pulling images required for setting up a Kubernetes cluster
~~~

The kubeadm output ended with:

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.27.16". Enjoy!

[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven't already done so.
~~~

At this point the control-plane static Pods and etcd were already on the target versions.

The post-upgrade check recorded these control-plane images:

~~~text
etcd-master                    registry.aliyuncs.com/google_containers/etcd:3.5.12-0
kube-apiserver-master          registry.aliyuncs.com/google_containers/kube-apiserver:v1.27.16
kube-controller-manager-master registry.aliyuncs.com/google_containers/kube-controller-manager:v1.27.16
kube-scheduler-master          registry.aliyuncs.com/google_containers/kube-scheduler:v1.27.16
~~~

The node versions were still unchanged:

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

### Certificates were also renewed automatically

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


### Update the control-plane kubelet and kubectl

After `kubeadm upgrade apply`, the control-plane components were on v1.27.16, but `kubectl get nodes` still showed the master kubelet on v1.27.0.

The master was drained as part of the maintenance sequence. I downloaded the Linux amd64 v1.27.16 kubelet and kubectl binaries from the Kubernetes release download site, verified each binary against its SHA256 file, and installed them under `/usr/local/bin`. I then restarted kubelet, checked the versions and node status, and uncordoned the master after confirming it was ready.

~~~bash
set -euo pipefail

TARGET=v1.27.16
ARCH=amd64

for binary in kubelet kubectl; do
  curl -fL \
    "https://dl.k8s.io/release/${TARGET}/bin/linux/${ARCH}/${binary}" \
    -o "/tmp/${binary}-${TARGET}"

  curl -fL \
    "https://dl.k8s.io/release/${TARGET}/bin/linux/${ARCH}/${binary}.sha256" \
    -o "/tmp/${binary}-${TARGET}.sha256"

  EXPECTED="$(cat "/tmp/${binary}-${TARGET}.sha256")"
  printf '%s  %s\n' "$EXPECTED" "/tmp/${binary}-${TARGET}" | sha256sum -c -

  install -o root -g root -m 0755 \
    "/tmp/${binary}-${TARGET}" \
    "/usr/local/bin/${binary}"
done
~~~

Restart kubelet and verify the installed versions and master node status:

~~~bash
systemctl restart kubelet
kubelet --version
kubectl version
kubectl get node master
~~~

After confirming the node is ready, uncordon the master:

~~~bash
kubectl uncordon master
~~~

The final `kubectl get nodes` output later in the article confirms the master version together with the workers.

## Upgrade kubelet and workers

After the control-plane work was complete, the workers were upgraded one at a time:

~~~text
update kubeadm
→ kubeadm upgrade node
→ drain
→ update kubelet
→ restart kubelet
→ verify
→ uncordon
~~~

In this procedure, I run the cluster-management `kubectl` commands from the control-plane node. The worker steps therefore update kubeadm and kubelet only; the workers do not need a local kubectl installation.

The repeated worker steps are not expanded node by node below. Only the drain differences are kept.

### node1: the first drain was blocked by emptyDir

The first attempt was:

~~~bash
kubectl drain node1 --ignore-daemonsets
~~~

It returned:

~~~text
node/node1 cordoned
cannot delete Pods with local storage (use --delete-emptydir-data to override):
  kube-system/metrics-server-...
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...
~~~

`emptyDir` was the direct reason for this drain failure. Adding `--delete-emptydir-data` allows the Pods to be evicted but discards their local temporary data.

node1 was later drained and its kubelet updated. The node was then observed as:

~~~text
NAME    STATUS                     ROLES    AGE    VERSION
node1   Ready,SchedulingDisabled   worker   262d   v1.27.16
~~~

At that point only expected DaemonSet Pods such as Calico, kube-proxy, and node-exporter remained on node1 before it was uncordoned.

### node3 and node4: the same drain problem appeared again

The first node3 drain also failed:

~~~bash
kubectl drain node3 --ignore-daemonsets --timeout=5m
~~~

Cropped output:

~~~text
node/node3 cordoned
cannot delete Pods with local storage:
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...
~~~

The first node4 drain encountered the same kind of blocker:

~~~bash
kubectl drain node4 --ignore-daemonsets --timeout=5m
~~~

The node4 drain reported Pods with local storage that could not be deleted, including:

~~~text
cannot delete Pods with local storage:
  kube-system/metrics-server-...
  monitoring/prometheus-adapter-...
~~~

After the ordinary workload Pods had moved away, node4 was observed as:

~~~text
NAME    STATUS                     ROLES    AGE    VERSION
node4   Ready,SchedulingDisabled   worker   260d   v1.27.0
~~~

Only DaemonSet Pods remained:

~~~text
calico-node-...
kube-proxy-...
node-exporter-...
~~~

node4 was then updated as well; the later pre-check before node2 showed node4 as `Ready v1.27.16`.

The repeated failures show that a Pod evicted from one worker can land on a worker that has not yet been maintained, so the same drain blocker can reappear later in the sequence.

### node2: drain first, then follow the error to Prometheus

node2 was the last worker in this round. By this point the earlier workers had already exposed the `emptyDir` issue, so node2 was handled with the same maintenance flow: run drain first rather than assuming that Prometheus would be a problem.

~~~bash
kubectl drain node2 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=5m
~~~

This drain did not complete normally. Only after seeing the actual drain error did the investigation turn to `monitoring/prometheus-k8s-0`. The PDB and volume checks below were therefore **post-failure troubleshooting**, not pre-upgrade Prometheus checks.

First inspect the PDB:

~~~bash
kubectl -n monitoring get pdb prometheus-k8s -o wide
~~~

~~~text
NAME             MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-k8s   1               N/A               0
~~~

The important value here is `ALLOWED DISRUPTIONS=0`. In that state, `prometheus-k8s-0` could not be evicted through a normal eviction, which is consistent with the Prometheus eviction problem seen during drain.

Next, check where the Prometheus data actually lives:

~~~bash
kubectl -n monitoring get pvc
kubectl get storageclass
kubectl get pv
~~~

The commands returned:

~~~text
No resources found in monitoring namespace.
No resources found
No resources found
~~~

Then inspect the volumes on `prometheus-k8s-0` directly:

~~~bash
kubectl -n monitoring get pod prometheus-k8s-0 \
  -o jsonpath='{range .spec.volumes[*]}{.name}{" => PVC="}{.persistentVolumeClaim.claimName}{" hostPath="}{.hostPath.path}{" emptyDir="}{.emptyDir}{"\n"}{end}'
~~~

The database volume was:

~~~text
prometheus-k8s-db => PVC= hostPath= emptyDir={}
~~~

So this Prometheus instance did not use a PVC. Its TSDB data lived in an `emptyDir`, which means local historical data would not survive deletion and recreation of the Pod.

Before continuing, the PDB configuration was saved in the upgrade log:

~~~bash
RUN_DIR=/root/k8s-upgrade-log/v1.27.0-to-v1.27.16

kubectl -n monitoring get pdb prometheus-k8s -o yaml \
  > "$RUN_DIR/48-prometheus-k8s-pdb-before.yaml"
~~~

The actual troubleshooting order for node2 was therefore:

~~~text
run drain
→ drain fails
→ follow the error to prometheus-k8s
→ inspect the PDB and find ALLOWED DISRUPTIONS=0
→ inspect PVC / StorageClass / PV
→ inspect the Pod volumes and confirm the TSDB uses emptyDir
→ assess the data impact of eviction/recreation
→ handle the blocker and continue the node2 upgrade
~~~

This is also different from the earlier `prometheus-adapter` `emptyDir` blockers seen on other workers. The node2 investigation here concerns `prometheus-k8s` itself.

node2 was subsequently upgraded successfully; the final node state is shown in the next section.

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

## References

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch releases</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/upgrading-linux-nodes/" target="_blank" rel="noopener noreferrer">Upgrading Linux nodes</a>
- <a href="https://kubernetes.io/releases/version-skew-policy/" target="_blank" rel="noopener noreferrer">Kubernetes version skew policy</a>
- <a href="https://kubernetes.io/docs/reference/config-api/kubeadm-config.v1beta3/" target="_blank" rel="noopener noreferrer">kubeadm Configuration (v1beta3)</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain</a>
