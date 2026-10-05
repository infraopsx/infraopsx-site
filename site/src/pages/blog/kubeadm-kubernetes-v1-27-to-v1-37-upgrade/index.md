---
layout: ../../../layouts/ArticleLayout.astro
title: "Kubernetes v1.27 to v1.37: A kubeadm Cluster Upgrade Log"
description: "A practical kubeadm upgrade log for a 5-node Kubernetes cluster moving from v1.27 toward v1.37. It currently covers v1.27.0 through v1.30.14, including etcd backups, worker drains, PodDisruptionBudgets, Calico, upgrade-plan differences, and post-upgrade verification."
pubDate: "2026-10-02"
category: Kubernetes
tags:
  - Kubernetes
  - kubeadm
  - Upgrade
  - etcd
  - Calico
  - PodDisruptionBudget
  - PDB
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

## Upgrade worker nodes

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

In this procedure, I run the cluster-management `kubectl` commands from the control-plane node. The worker steps therefore update kubeadm and kubelet only; the workers do not need a local kubectl installation. The earlier sections already show how kubeadm and kubelet binaries are downloaded, verified with SHA256, and installed, so those repeated binary-update steps are not expanded again here.

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

### node2: after allowing emptyDir deletion, the Prometheus PDB blocked drain

The first node2 drain hit the same `emptyDir` restriction seen earlier. After confirming that the temporary data could be discarded, the drain was retried with `--delete-emptydir-data`:

~~~bash
kubectl drain node2 --ignore-daemonsets --delete-emptydir-data
~~~

Ordinary Pods started moving, but `prometheus-k8s-0` could not be evicted and drain kept retrying:

~~~text
evicting pod monitoring/prometheus-k8s-0
error when evicting pods/"prometheus-k8s-0" -n "monitoring" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
~~~

These are two different layers of protection. `--delete-emptydir-data` only allows drain to remove Pods that use `emptyDir`; it does not bypass a PodDisruptionBudget. The Prometheus PDB was checked next:

~~~bash
kubectl -n monitoring get pdb prometheus-k8s -o wide
~~~

Its state was:

~~~text
NAME             MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-k8s   1               N/A               0
~~~

With `ALLOWED DISRUPTIONS=0`, a normal eviction could not disrupt this Pod in the current replica and PDB state.

Before changing anything, the original PDB was saved:

~~~bash
RUN_DIR=/root/k8s-upgrade-log/v1.27.0-to-v1.27.16

kubectl -n monitoring get pdb prometheus-k8s -o yaml \
  > "$RUN_DIR/48-prometheus-k8s-pdb-before.yaml"
~~~

The PDB explained why normal eviction failed, but it was also necessary to check what would happen to the data if the Pod were deleted and recreated. PVCs, StorageClasses, and PVs were checked:

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

The `prometheus-k8s-0` volumes were then inspected directly:

~~~bash
kubectl -n monitoring get pod prometheus-k8s-0 \
  -o jsonpath='{range .spec.volumes[*]}{.name}{" => PVC="}{.persistentVolumeClaim.claimName}{" hostPath="}{.hostPath.path}{" emptyDir="}{.emptyDir}{"\n"}{end}'
~~~

The database volume was:

~~~text
prometheus-k8s-db => PVC= hostPath= emptyDir={}
~~~

So node2 had two independent constraints at the same time: the PDB blocked normal eviction, while the Prometheus TSDB itself lived in the Pod's `emptyDir`. Deleting and recreating that Pod would therefore also discard its local TSDB history.

In this test cluster, the PDB was relaxed temporarily: the original PDB was saved, `prometheus-k8s` was changed from `minAvailable: 1` to `minAvailable: 0`, node2 was drained, and the original PDB was restored after the maintenance:

~~~text
save the original PDB
→ temporarily change minAvailable: 1 to 0
→ drain node2 again
→ complete node maintenance
→ restore the original PDB
~~~

That was acceptable here because this was a test cluster and the Prometheus TSDB had already been confirmed to use `emptyDir`, so losing its local history during this maintenance window was acceptable. On a production cluster with the same layout, Prometheus persistence and replica strategy should be addressed before relaxing the PDB and continuing the drain.

### node3 and node4: continue with the same emptyDir handling

The first drain attempt on node3 and node4 was also blocked by Pods using `emptyDir`:

~~~bash
kubectl drain node3 --ignore-daemonsets
kubectl drain node4 --ignore-daemonsets
~~~

Both nodes hit the same class of error:

~~~text
cannot delete Pods with local storage (use --delete-emptydir-data to override):
~~~

After confirming that the temporary data could be discarded, the drain commands were retried with:

~~~bash
kubectl drain node3 --ignore-daemonsets --delete-emptydir-data
kubectl drain node4 --ignore-daemonsets --delete-emptydir-data
~~~

After drain completed, both nodes were `SchedulingDisabled`. Their kubelets had not yet been updated, so they still reported v1.27.0:

~~~text
NAME    STATUS                     ROLES    AGE    VERSION
node3   Ready,SchedulingDisabled   worker   260d   v1.27.0
node4   Ready,SchedulingDisabled   worker   260d   v1.27.0
~~~

The kubelet on each node was then updated, and each node was uncordoned after verification. The final state is shown in the next section.

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

## v1.27.16 → v1.28.15

The first stage already covered binary downloads, SHA256 verification, the etcd snapshot, control-plane upgrade, worker drain, kubelet replacement, and PDB handling in detail. For this minor-version jump, I do not repeat those mechanics. Backup and etcd snapshot follow the same procedure described earlier; this section focuses only on what changed for v1.27.16 → v1.28.15, the compatibility preparation, and the final verification.

### Upgrade Calico before Kubernetes

The cluster was running Calico v3.25.0 installed from manifests. Because the Kubernetes target is v1.28.15, I upgraded Calico to v3.27.5 before changing Kubernetes itself.

This is not a hard kubeadm requirement, and it does not mean Calico v3.25.0 is guaranteed to fail on Kubernetes 1.28. The reason for doing it first is operational: the CNI is one of the most fundamental cluster networking components, and each Calico release is tested against a defined range of Kubernetes versions. Moving the CNI closer to the target Kubernetes version first separates the networking change from the control-plane change and reduces the number of variables if a networking problem appears later.

This cluster also has one local setting that must survive the Calico upgrade:

~~~yaml
- name: IP
  value: "autodetect"
- name: IP_AUTODETECTION_METHOD
  value: "can-reach=10.10.10.1"
~~~

First download the official v3.27.5 manifest and copy it to a local file that can preserve the cluster-specific settings:

~~~bash
curl -LO \
  https://raw.githubusercontent.com/projectcalico/calico/v3.27.5/manifests/calico.yaml

cp calico.yaml calico-v3.27.5-custom.yaml
~~~

Then keep the `IP` and `IP_AUTODETECTION_METHOD` settings shown above in `calico-v3.27.5-custom.yaml`, and apply it:

~~~bash
kubectl apply -f calico-v3.27.5-custom.yaml
~~~

Then wait for both Calico components to finish rolling out:

~~~bash
kubectl -n kube-system rollout status daemonset/calico-node
kubectl -n kube-system rollout status deployment/calico-kube-controllers
~~~

The resulting state was:

~~~text
calico-node                 5/5 Ready
calico-kube-controllers     1/1 Ready
Calico                      v3.27.5
~~~

The custom autodetection setting was checked again:

~~~bash
kubectl -n kube-system get daemonset calico-node \
  -o jsonpath='{range .spec.template.spec.containers[?(@.name=="calico-node")].env[*]}{.name}={.value}{"\n"}{end}' \
  | grep -E '^IP=|^IP_AUTODETECTION_METHOD='
~~~

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

Only after Calico was healthy did I move on to Kubernetes v1.28.15.

### Confirm the v1.28.15 upgrade plan

After updating the control-plane kubeadm binary to v1.28.15 and verifying its SHA256 checksum, I ran:

~~~bash
kubeadm upgrade plan v1.28.15
~~~

The actual plan was:

| Component | Current | Target |
| --- | --- | --- |
| kube-apiserver | v1.27.16 | v1.28.15 |
| kube-controller-manager | v1.27.16 | v1.28.15 |
| kube-scheduler | v1.27.16 | v1.28.15 |
| kube-proxy | v1.27.16 | v1.28.15 |
| CoreDNS | v1.10.1 | v1.10.1 |
| etcd | 3.5.12-0 | 3.5.15-0 |
| kubelet | all 5 nodes on v1.27.16 | v1.28.15 |

### Upgrade the control-plane

Before the actual upgrade, I ran a dry run first:

~~~bash
kubeadm upgrade apply v1.28.15 --dry-run --yes
~~~

It ended with:

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

Then I applied the upgrade:

~~~bash
kubeadm upgrade apply v1.28.15 --yes
~~~

The final result was:

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.28.15". Enjoy!
~~~

At that point the control-plane static Pods and etcd were already on their target versions, while the master kubelet still had to be updated separately.

For the master drain I reused the `emptyDir` handling already established earlier instead of repeating the same initial failure:

~~~bash
kubectl drain master \
  --ignore-daemonsets \
  --delete-emptydir-data
~~~

The kubelet and kubectl binaries were then updated using the same download, checksum, and replacement procedure shown earlier. After restarting kubelet and confirming that the master was `Ready,SchedulingDisabled` on v1.28.15, I uncordoned it:

~~~bash
kubectl uncordon master
~~~

### Upgrade workers one at a time

The worker sequence did not change:

~~~text
update kubeadm
→ kubeadm upgrade node
→ drain
→ update kubelet
→ restart kubelet
→ verify
→ uncordon
~~~

The four workers ended this round as follows:

| Node | Result | Difference in this round |
| --- | --- | --- |
| node1 | v1.28.15 / Ready | drain was blocked again by the Prometheus PDB |
| node2 | v1.28.15 / Ready | no new issue |
| node3 | v1.28.15 / Ready | no new issue |
| node4 | v1.28.15 / Ready | drain was blocked again by the Prometheus PDB |

node1 and node4 hit the same constraint already analyzed in the previous section:

~~~text
Cannot evict pod as it would violate the pod's disruption budget.
~~~

I therefore reused the already-tested handling instead of repeating the PDB and `emptyDir` explanation: temporarily change the `prometheus-k8s` PDB from `minAvailable: 1` to `minAvailable: 0`, complete the drain, wait until `prometheus-k8s-0` is `2/2 Running` on another node, and then restore `minAvailable: 1`.

### Final v1.28.15 state

After all nodes were complete:

~~~bash
kubectl get nodes -o wide
~~~

~~~text
NAME     STATUS   ROLES           VERSION
master   Ready    control-plane   v1.28.15
node1    Ready    worker          v1.28.15
node2    Ready    worker          v1.28.15
node3    Ready    worker          v1.28.15
node4    Ready    worker          v1.28.15
~~~

The key component versions were:

| Component | Final state |
| --- | --- |
| kube-apiserver | v1.28.15 |
| kube-controller-manager | v1.28.15 |
| kube-scheduler | v1.28.15 |
| etcd | 3.5.15-0 |
| CoreDNS | v1.10.1, 2/2 Ready |
| kube-proxy | v1.28.15, 5/5 Ready |
| Calico | v3.27.5, calico-node 5/5 Ready |
| Prometheus | 2/2 Running |
| Prometheus PDB | minAvailable=1 |

The local Calico autodetection setting was still preserved:

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

API readiness:

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

ended with:

~~~text
[+]ping ok
[+]etcd ok
[+]etcd-readiness ok
...
readyz check passed
~~~

I also checked for Pods outside the normal terminal states:

~~~bash
kubectl get pods -A --no-headers | \
  awk '$4 != "Running" && $4 != "Completed" {print}'
~~~

The command returned no output.

### Verify DNS, Service networking, and the API from inside a Pod

Node and control-plane readiness are useful, but I also wanted one functional check from an ordinary Pod.

First, verify cluster DNS:

~~~bash
kubectl run dns-smoke-test \
  --image=busybox:1.36 \
  --restart=Never \
  --command -- \
  nslookup kubernetes.default.svc.cluster.local

kubectl logs dns-smoke-test
~~~

The lookup returned:

~~~text
Server:  10.96.0.10
Name:    kubernetes.default.svc.cluster.local
Address: 10.96.0.1
~~~

Then use a curl container to call the Kubernetes API Service:

~~~bash
kubectl run api-smoke-test \
  --image=curlimages/curl:8.10.1 \
  --restart=Never \
  --command -- sh -c '
    TOKEN="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
    curl -sS \
      --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
      -H "Authorization: Bearer ${TOKEN}" \
      https://kubernetes.default.svc/version
  '

kubectl logs api-smoke-test
~~~

The returned version data included:

~~~json
{
  "major": "1",
  "minor": "28",
  "gitVersion": "v1.28.15"
}
~~~

This extends the verification beyond node status: DNS from a Pod can resolve the Service, the Service ClusterIP can reach the API server, TLS CA verification and ServiceAccount authentication work, and the API returns the expected v1.28.15 version.

Remove the temporary Pods when finished:

~~~bash
kubectl delete pod dns-smoke-test api-smoke-test
~~~

That completes the v1.27.16 → v1.28.15 stage.

## v1.28.15 → v1.29.14

This round reused the upgrade procedure already proven in the earlier stages, so I do not repeat the binary downloads, SHA256 verification, etcd snapshot, and basic per-node maintenance mechanics. This section focuses on the compatibility checks added for v1.29, the upgrade-plan difference, and the final verification.

### Check APIs removed in v1.29

First, check whether the apiserver has actually observed requests for APIs scheduled to be removed in v1.29:

~~~bash
kubectl get --raw /metrics \
  | grep 'apiserver_requested_deprecated_apis' \
  | grep 'removed_release="1.29"' || true
~~~

There was no output.

I also checked the current storage objects and a few legacy in-tree storage fields:

~~~bash
kubectl get storageclass -o wide
kubectl get pv -o wide

kubectl get pv -o yaml \
  | grep -nE 'gcePersistentDisk:|rbd:|cephfs:' || true

kubectl get --raw /metrics \
  | grep '^apiserver_requested_deprecated_apis' || true
~~~

This cluster had no StorageClasses or PVs, and the deprecated-API metric query also returned no output.

### Re-run the upgrade plan with the target kubeadm

This round exposed one useful difference worth keeping in the log.

The control-plane still had kubeadm v1.28.15 when the first v1.29.14 plan was viewed. That plan did not fully reflect the CoreDNS and etcd target changes. I then updated kubeadm on the control-plane to v1.29.14 and ran:

~~~bash
kubeadm upgrade plan v1.29.14
~~~

That second result became the authoritative plan for this round:

| Component | Current | Target |
| --- | --- | --- |
| kube-apiserver | v1.28.15 | v1.29.14 |
| kube-controller-manager | v1.28.15 | v1.29.14 |
| kube-scheduler | v1.28.15 | v1.29.14 |
| kube-proxy | v1.28.15 | v1.29.14 |
| CoreDNS | v1.10.1 | v1.11.1 |
| etcd | 3.5.15-0 | 3.5.16-0 |
| kubelet | all 5 nodes on v1.28.15 | v1.29.14 |

The operational lesson from this round is to use the plan generated by the target-version kubeadm as the final source of truth for a minor-version jump instead of relying on the old kubeadm's view of the target release.

### Dry run and control-plane upgrade

Before changing the cluster:

~~~bash
kubeadm upgrade apply v1.29.14 --dry-run --yes
~~~

It ended with:

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

Then apply the real upgrade:

~~~bash
kubeadm upgrade apply v1.29.14 --yes
~~~

The final output included:

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.29.14". Enjoy!
~~~

At that point the control-plane static Pods, etcd, CoreDNS, and kube-proxy had moved to the target versions from the plan.

The key versions observed after the upgrade were:

| Component | Version / state |
| --- | --- |
| kube-apiserver | v1.29.14 |
| kube-controller-manager | v1.29.14 |
| kube-scheduler | v1.29.14 |
| etcd | 3.5.16-0 |
| CoreDNS | v1.11.1 |
| kube-proxy | v1.29.14 |

The master kubelet and kubectl were then updated, kubelet was restarted, and the running kubelet was verified as v1.29.14. After the node returned ready:

~~~bash
kubectl uncordon master
~~~

Final master state:

~~~text
master   Ready   control-plane   v1.29.14
~~~

### Upgrade workers one at a time

The workers were still handled one at a time. The actual sequence in this round was:

~~~text
drain
→ update kubeadm
→ kubeadm upgrade node
→ update kubelet
→ restart kubelet
→ verify the running kubelet
→ uncordon
~~~

On every worker, \`kubeadm upgrade node\` completed with:

~~~text
[upgrade] The configuration for this node was successfully updated!
~~~

All four workers eventually returned to Ready / v1.29.14.

node1 and node4 again hit the already-understood Prometheus PDB during drain:

~~~text
Cannot evict pod as it would violate the pod's disruption budget.
~~~

At the time, the \`prometheus-k8s\` PDB was still:

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

I reused the previously verified handling: temporarily change \`minAvailable\` from 1 to 0, complete the drain, wait for \`prometheus-k8s-0\` to return to \`2/2 Running\` on another node, then restore:

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

node2 and node3 drained without a new blocker in this round.

### Final state and functional verification

After all nodes were complete:

~~~bash
kubectl get nodes -o wide
~~~

Result:

~~~text
NAME     STATUS   ROLES           VERSION
master   Ready    control-plane   v1.29.14
node1    Ready    worker          v1.29.14
node2    Ready    worker          v1.29.14
node3    Ready    worker          v1.29.14
node4    Ready    worker          v1.29.14
~~~

All control-plane static Pods were \`Running\`, CoreDNS was \`2/2\`, kube-proxy was \`5/5\`, and the Calico node DaemonSet was \`5/5\`. A check for Pods outside the normal terminal states returned only the header:

~~~bash
kubectl get pods -A | \
  awk 'NR==1 || ($4!="Running" && $4!="Completed")'
~~~

API readiness:

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

ended with:

~~~text
readyz check passed
~~~

Calico remained on v3.27.5, and the local IP autodetection settings were still present:

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

In this cluster, \`metrics.k8s.io\` is actually served by \`monitoring/prometheus-adapter\`. After the upgrade:

~~~bash
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl top nodes
kubectl top pods -A
~~~

The APIService was \`AVAILABLE=True\`, and both \`kubectl top\` commands returned CPU and memory data normally.

Finally, repeat the Pod DNS and Kubernetes API Service checks.

DNS:

~~~bash
kubectl run dns-smoke-test \
  --image=busybox:1.36 \
  --restart=Never \
  --command -- \
  sh -c 'nslookup kubernetes.default.svc.cluster.local'

kubectl logs dns-smoke-test
~~~

The lookup returned:

~~~text
Server:         10.96.0.10
Address:        10.96.0.10:53

Name:   kubernetes.default.svc.cluster.local
Address: 10.96.0.1
~~~

API:

~~~bash
kubectl run api-smoke-test \
  --image=curlimages/curl:8.12.1 \
  --restart=Never \
  --command -- \
  sh -c '
    TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
    CACERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

    curl -fsS \
      --connect-timeout 10 \
      --max-time 30 \
      --cacert "$CACERT" \
      -H "Authorization: Bearer $TOKEN" \
      https://kubernetes.default.svc/version
  '

kubectl logs api-smoke-test
~~~

It returned:

~~~json
{
  "major": "1",
  "minor": "29",
  "gitVersion": "v1.29.14"
}
~~~

This confirms that Pod DNS, the Service ClusterIP path, API TLS verification, ServiceAccount authentication, and access to the API server all still work after the upgrade.

Remove the temporary Pods when finished:

~~~bash
kubectl delete pod api-smoke-test dns-smoke-test
~~~

That completes the v1.28.15 → v1.29.14 stage.


## v1.29.14 → v1.30.14

This round reused the download, SHA256 verification, and per-node maintenance mechanics already proven earlier. I only expand the differences that actually mattered for v1.30: upgrading Calico first, an etcd patch-level downgrade appearing in the upgrade plan, explicitly leaving etcd unchanged, and the Prometheus PDB that blocked two worker drains.

### Upgrade Calico to v3.28.5 first

At the start of this round the cluster was on Kubernetes v1.29.14 with Calico v3.27.5. Before changing Kubernetes itself, I upgraded Calico to v3.28.5 and preserved the cluster-specific IP autodetection settings:

~~~yaml
- name: IP
  value: "autodetect"
- name: IP_AUTODETECTION_METHOD
  value: "can-reach=10.10.10.1"
~~~

I downloaded the v3.28.5 manifest and kept a local customized copy:

~~~bash
curl -fL \
  https://raw.githubusercontent.com/projectcalico/calico/v3.28.5/manifests/calico.yaml \
  -o calico-v3.28.5.yaml

cp calico-v3.28.5.yaml calico-v3.28.5-custom.yaml
~~~

After preserving the settings above, I applied the manifest and waited for both Calico workloads:

~~~bash
kubectl apply -f calico-v3.28.5-custom.yaml

kubectl -n kube-system rollout status daemonset/calico-node
kubectl -n kube-system rollout status deployment/calico-kube-controllers
~~~

The final state was:

~~~text
calico-node                 5/5 Ready
calico-kube-controllers     1/1 Ready
Calico                      v3.28.5
~~~

The custom autodetection values were still present:

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

Before moving on to Kubernetes, I also repeated the DNS and Kubernetes API Service smoke tests from an ordinary Pod. Both passed.

### The target-version kubeadm plan exposed an etcd patch downgrade

After updating kubeadm on the control-plane to v1.30.14, I generated the authoritative plan:

~~~bash
kubeadm upgrade plan v1.30.14
~~~

The actual plan was:

| Component | Current | Target |
| --- | --- | --- |
| kube-apiserver | v1.29.14 | v1.30.14 |
| kube-controller-manager | v1.29.14 | v1.30.14 |
| kube-scheduler | v1.29.14 | v1.30.14 |
| kube-proxy | v1.29.14 | v1.30.14 |
| CoreDNS | v1.11.1 | v1.11.3 |
| etcd | 3.5.16-0 | 3.5.15-0 |
| kubelet | all 5 nodes on v1.29.14 | v1.30.14 |

The unusual part was etcd:

~~~text
3.5.16-0 → 3.5.15-0
~~~

The etcd target in this plan was a lower patch release than the version already running in the cluster. For this upgrade I chose not to let kubeadm perform that etcd change and kept the existing 3.5.16-0.

### Dry-run with the etcd upgrade disabled

First:

~~~bash
kubeadm upgrade apply v1.30.14 \
  --dry-run \
  --yes \
  --etcd-upgrade=false
~~~

The dry-run ended with:

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

Reviewing the dry-run output showed new static Pod manifests for kube-apiserver, kube-controller-manager, and kube-scheduler, CoreDNS targeting v1.11.3, and kube-proxy targeting v1.30.14. There was no step writing a new etcd static Pod manifest.

I then applied the real upgrade:

~~~bash
kubeadm upgrade apply v1.30.14 \
  --yes \
  --etcd-upgrade=false
~~~

It finished with:

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.30.14". Enjoy!
~~~

The running versions after the control-plane upgrade were:

| Component | Running version |
| --- | --- |
| kube-apiserver | v1.30.14 |
| kube-controller-manager | v1.30.14 |
| kube-scheduler | v1.30.14 |
| etcd | 3.5.16-0 |
| CoreDNS | v1.11.3 |
| kube-proxy | v1.30.14 |

This directly confirmed that etcd remained on 3.5.16-0 instead of moving to the 3.5.15-0 target shown by the plan.

CoreDNS and kube-proxy were still rolling immediately after `kubeadm upgrade apply`, so I waited for both:

~~~bash
kubectl -n kube-system rollout status deployment/coredns --timeout=10m
kubectl -n kube-system rollout status daemonset/kube-proxy --timeout=10m
~~~

They finished at CoreDNS 2/2 and kube-proxy 5/5.

### Update the master kubelet

The master was drained normally:

~~~bash
kubectl drain master \
  --ignore-daemonsets \
  --delete-emptydir-data
~~~

I then updated kubelet and kubectl to v1.30.14, restarted kubelet, and checked both the installed binary and the process that was actually running:

~~~bash
kubelet --version
kubectl version --client

PID=$(pidof kubelet)
readlink -f /proc/$PID/exe
/proc/$PID/exe --version
~~~

Both kubelet checks reported:

~~~text
Kubernetes v1.30.14
~~~

Immediately after restarting kubelet, the first kubectl request briefly returned:

~~~text
The connection to the server 10.10.10.100:6443 was refused
~~~

I did not change configuration or roll anything back. A follow-up inspection showed port 6443 listening again and etcd, kube-apiserver, kube-controller-manager, and kube-scheduler all Running. The kubelet log showed those static Pods starting again within roughly a dozen seconds.

I then checked:

~~~bash
kubectl get node master -o wide
kubectl get --raw='/readyz?verbose'
~~~

The master was `Ready,SchedulingDisabled / v1.30.14`, and all readyz checks passed. Only then did I uncordon it:

~~~bash
kubectl uncordon master
~~~

### Upgrade workers one at a time

The actual worker sequence in this round was:

~~~text
drain
→ update kubeadm
→ kubeadm upgrade node
→ update kubelet / kubectl
→ restart kubelet
→ verify the running kubelet
→ uncordon
~~~

node1 and node2 drained without a new blocker.

On node3, `prometheus-k8s-0` hit the PDB during drain:

~~~text
Cannot evict pod as it would violate the pod's disruption budget.
~~~

At that point the PDB was:

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

I temporarily changed `prometheus-k8s` from `minAvailable: 1` to `minAvailable: 0`, reran the drain, completed the node upgrade, and uncordoned node3. After `prometheus-k8s-0` came back as `2/2 Running` on node4, I restored `minAvailable: 1`.

By the time node4 was drained, the same Prometheus Pod was running there, so the same PDB block occurred again. I used the same handling: temporarily set the PDB to 0, finish the drain and node upgrade, uncordon node4, wait for Prometheus to return to `2/2 Running` on node3, and then restore:

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

All four workers eventually returned `Ready / v1.30.14`.

### Final state and functional verification

After all nodes were complete:

~~~text
NAME     STATUS   ROLES           VERSION
master   Ready    control-plane   v1.30.14
node1    Ready    worker          v1.30.14
node2    Ready    worker          v1.30.14
node3    Ready    worker          v1.30.14
node4    Ready    worker          v1.30.14
~~~

Final key component state:

| Component | Final state |
| --- | --- |
| kube-apiserver | v1.30.14 / Running |
| kube-controller-manager | v1.30.14 / Running |
| kube-scheduler | v1.30.14 / Running |
| etcd | 3.5.16-0 / Running |
| CoreDNS | v1.11.3 / 2/2 Ready |
| kube-proxy | v1.30.14 / 5/5 Ready |
| Calico | v3.28.5 / calico-node 5/5 Ready |
| calico-kube-controllers | 1/1 Ready |
| Prometheus PDB | minAvailable=1 |

A check for Pods outside the normal Running or Succeeded phases:

~~~bash
kubectl get pods -A \
  --field-selector=status.phase!=Running,status.phase!=Succeeded
~~~

returned:

~~~text
No resources found
~~~

API readiness:

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

ended with:

~~~text
readyz check passed
~~~

In this cluster, `metrics.k8s.io` is still served by `monitoring/prometheus-adapter`. After the upgrade the APIService was `AVAILABLE=True`, and `kubectl top nodes` returned CPU and memory data for all five nodes.

Finally I repeated the DNS and Kubernetes API Service checks from inside Pods.

DNS:

~~~text
Server:         10.96.0.10
Address:        10.96.0.10:53

Name:   kubernetes.default.svc.cluster.local
Address: 10.96.0.1
~~~

API:

~~~json
{
  "major": "1",
  "minor": "30",
  "gitVersion": "v1.30.14"
}
~~~

Both smoke Pods ended in `Completed` and were then removed.

That completes the v1.29.14 → v1.30.14 stage.

## References

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch releases</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/upgrading-linux-nodes/" target="_blank" rel="noopener noreferrer">Upgrading Linux nodes</a>
- <a href="https://kubernetes.io/releases/version-skew-policy/" target="_blank" rel="noopener noreferrer">Kubernetes version skew policy</a>
- <a href="https://kubernetes.io/docs/reference/config-api/kubeadm-config.v1beta3/" target="_blank" rel="noopener noreferrer">kubeadm Configuration (v1beta3)</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain</a>
- <a href="https://kubernetes.io/releases/1.28/" target="_blank" rel="noopener noreferrer">Kubernetes 1.28 release</a>
- <a href="https://kubernetes.io/releases/1.29/" target="_blank" rel="noopener noreferrer">Kubernetes 1.29 release</a>
- <a href="https://kubernetes.io/releases/1.30/" target="_blank" rel="noopener noreferrer">Kubernetes 1.30 release</a>
- <a href="https://docs.tigera.io/calico/latest/getting-started/kubernetes/requirements" target="_blank" rel="noopener noreferrer">Calico Kubernetes system requirements</a>
