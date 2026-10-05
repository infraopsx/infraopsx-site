---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes v1.27 到 v1.30：一次 kubeadm 集群升级记录"
description: "记录一个 5 节点 kubeadm 集群从 Kubernetes v1.27.0 逐步升级到 v1.30.14，包括 etcd 备份、worker drain、PodDisruptionBudget（PDB）、Calico、升级计划差异和升级后验证。"
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

这次升级的集群是 1 个 control-plane + 4 个 worker，不是 HA control-plane 集群。

| 项目 | 当前环境 |
| --- | --- |
| control-plane | 1 |
| worker | 4 |
| OS | Debian 12 |
| Kernel | 6.1.0-52-amd64 |
| Runtime | containerd 1.6.20 |
| 起始版本 | Kubernetes v1.27.0 |
| Kubernetes 二进制路径 | `/usr/local/bin` |

对于 3 个 control-plane 的 HA 集群，control-plane 的升级顺序、etcd 拓扑、负载均衡和可用性检查都会不同，因此不能把本文 control-plane 操作部分机械照搬到 HA 集群。

## 为什么第一步是 v1.27.16

Kubernetes 版本号可以直接拆成：

~~~text
v1.27.16
  │  │  └─ patch: 16
  │  └──── minor: 27
  └─────── major: 1
~~~

当前集群是 `v1.27.0`。这次先不跨到 1.28，而是先把 1.27.0 补到 1.27 系列最后一个 patch：`v1.27.16`。

Kubernetes 官方发布记录显示，1.27 系列最后一个 patch 版本是 1.27.16。kubeadm 不支持跳过 minor 版本升级，例如不能从 1.27 直接升级到 1.29，所以后面的路线会按 1.28、1.29……逐个 minor 往前走。

~~~text
1.27.0
→ 1.27.16
→ 1.28.15
→ 1.29.14
→ 1.30.14
~~~

1.27.16 并不是升级到 1.28 的硬性前置条件。这里选择它，是为了先把 1.27 系列补到最后一个 patch，再开始跨 minor。

## 升级前检查

先看节点：

~~~bash
kubectl get nodes -o wide
~~~

关键输出：

~~~text
NAME     STATUS   ROLES           AGE    VERSION   INTERNAL-IP    OS-IMAGE                         KERNEL-VERSION   CONTAINER-RUNTIME
master   Ready    control-plane   262d   v1.27.0   10.10.10.100   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node1    Ready    worker          262d   v1.27.0   10.10.10.101   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node2    Ready    worker          262d   v1.27.0   10.10.10.102   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node3    Ready    worker          262d   v1.27.0   10.10.10.103   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
node4    Ready    worker          260d   v1.27.0   10.10.10.104   Debian GNU/Linux 12 (bookworm)   6.1.0-52-amd64   containerd://1.6.20
~~~

再确认本机的 kubeadm、kubelet 和 kubectl：

~~~bash
kubeadm version -o short
kubelet --version
kubectl version
~~~

关键输出：

~~~text
v1.27.0
Kubernetes v1.27.0
Client Version: ... GitVersion:"v1.27.0" ...
Server Version: ... GitVersion:"v1.27.0" ...
~~~

再确认这次升级实际使用的二进制路径：

~~~bash
command -v kubeadm kubelet kubectl
systemctl cat kubelet
~~~

关键输出：

~~~text
/usr/local/bin/kubeadm
/usr/local/bin/kubelet
/usr/local/bin/kubectl

[Service]
ExecStart=/usr/local/bin/kubelet
...
ExecStart=/usr/local/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
~~~

升级前 API readiness 状态：

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

关键输出：

~~~text
[+]ping ok
[+]etcd ok
[+]etcd-readiness ok
...
readyz check passed
~~~

## 先做备份和 etcd snapshot

生成 checkpoint 目录和 snapshot 文件名：

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

这次实际生成的是：

~~~text
/root/k8s-upgrade-backup/20261002-155639-before-v1.27.16
~~~

先保存 kubeadm/kubelet 配置、节点和 workload 状态：

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

再备份当前三个二进制并记录 SHA256：

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

同时归档 `/etc/kubernetes` 和 kubelet 相关配置：

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

检查结果：

~~~text
OK: kubelet configuration archive verified
~~~

etcd snapshot 前先看 endpoint status：

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  endpoint status -w table
~~~

当时 etcd 是 3.5.7，DB 约 19 MB：

~~~text
+------------------------+---------+---------+-----------+------------+--------+
|        ENDPOINT        | VERSION | DB SIZE | IS LEADER | IS LEARNER | ERRORS |
+------------------------+---------+---------+-----------+------------+--------+
| https://127.0.0.1:2379 |   3.5.7 |   19 MB |      true |      false |        |
+------------------------+---------+---------+-----------+------------+--------+
~~~

再检查 endpoint health：

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

创建 snapshot：

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  snapshot save "/var/lib/etcd/$SNAP"
~~~

关键输出：

~~~text
Snapshot saved at /var/lib/etcd/etcd-before-v1.27.16-20261002-155639.db
~~~

把 snapshot 复制到 checkpoint 目录：

~~~bash
cp -a "/var/lib/etcd/$SNAP" "$BACKUP_DIR/etcd/"
~~~

检查 snapshot：

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

确认 host 上的临时 snapshot 和备份副本都存在后，删除 `/var/lib/etcd` 下的临时文件：

~~~bash
ls -lh \
  "/var/lib/etcd/$SNAP" \
  "$BACKUP_DIR/etcd/$SNAP"

rm -f "/var/lib/etcd/$SNAP"
~~~

最后为整个 checkpoint 生成 SHA256 校验清单，供后续复制备份或恢复前校验：

~~~bash
(
  cd "$BACKUP_DIR"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > SHA256SUMS
)
~~~

## 先更新 kubeadm 到 v1.27.16，再执行 upgrade plan

这一步只把 control-plane 节点上的 kubeadm 更新到 v1.27.16，集群本身还没有升级。

先下载目标版本 kubeadm 和 SHA256 文件：

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

校验结果：

~~~text
kubeadm-v1.27.16: OK
~~~

然后替换 kubeadm：

~~~bash
install -o root -g root -m 0755 \
  "/tmp/kubeadm-${TARGET}" \
  /usr/local/bin/kubeadm
~~~

替换后确认 kubeadm 版本和集群版本：

~~~bash
kubeadm version -o short
kubectl version
~~~

关键输出：

~~~text
v1.27.16
...
Server Version: ... GitVersion:"v1.27.0" ...
~~~

- `kubeadm v1.27.16`：本机 kubeadm 当前版本；
- `Server v1.27.0`：集群当前版本。

确认本机 kubeadm 已经是 v1.27.16，而集群仍然是 v1.27.0 后，生成升级计划：

~~~bash
kubeadm upgrade plan "$TARGET"
~~~

将 upgrade plan 中的版本信息整理如下：

| 组件 | 当前版本 | 目标版本 |
| --- | --- | --- |
| kube-apiserver | v1.27.0 | v1.27.16 |
| kube-controller-manager | v1.27.0 | v1.27.16 |
| kube-scheduler | v1.27.0 | v1.27.16 |
| kube-proxy | v1.27.0 | v1.27.16 |
| CoreDNS | v1.10.1 | v1.10.1 |
| etcd | 3.5.7-0 | 3.5.12-0 |
| kubelet | 5 个节点均为 v1.27.0 | v1.27.16（后续逐节点升级） |


## 升级 control-plane

前面 checkpoint 已经保存了 `$BACKUP_DIR/config/kubeadm-config.yaml`。其中的 ClusterConfiguration 包含：

~~~yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
imageRepository: registry.aliyuncs.com/google_containers
kubernetesVersion: v1.27.0
~~~

使用更新后的 kubeadm v1.27.16 查看本次升级所需镜像：

~~~bash
kubeadm config images list \
  --kubernetes-version v1.27.16 \
  --image-repository registry.aliyuncs.com/google_containers
~~~

实际输出：

~~~text
registry.aliyuncs.com/google_containers/kube-apiserver:v1.27.16
registry.aliyuncs.com/google_containers/kube-controller-manager:v1.27.16
registry.aliyuncs.com/google_containers/kube-scheduler:v1.27.16
registry.aliyuncs.com/google_containers/kube-proxy:v1.27.16
registry.aliyuncs.com/google_containers/pause:3.9
registry.aliyuncs.com/google_containers/etcd:3.5.12-0
registry.aliyuncs.com/google_containers/coredns:v1.10.1
~~~

确认镜像列表无误后，提前拉取镜像：

~~~bash
kubeadm config images pull \
  --kubernetes-version v1.27.16 \
  --image-repository registry.aliyuncs.com/google_containers
~~~

先做 dry-run：

~~~bash
kubeadm upgrade apply v1.27.16 --dry-run
~~~

dry-run 的 kubeadm 结束输出是：

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

然后再执行：

~~~bash
kubeadm upgrade apply v1.27.16 --yes
~~~

开头的输出可以看到 kubeadm 读取的是集群配置：

~~~text
[upgrade/config] Reading configuration from the cluster...
[upgrade/version] You have chosen to change the cluster version to "v1.27.16"
[upgrade/versions] Cluster version: v1.27.0
[upgrade/versions] kubeadm version: v1.27.16
[upgrade/prepull] Pulling images required for setting up a Kubernetes cluster
~~~

结束时的关键输出：

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.27.16". Enjoy!

[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven't already done so.
~~~

这时 control-plane static Pod 和 etcd 已经更新，但 kubelet 还没更新。

升级后的检查日志里，control-plane 镜像已经变成：

~~~text
etcd-master                    registry.aliyuncs.com/google_containers/etcd:3.5.12-0
kube-apiserver-master          registry.aliyuncs.com/google_containers/kube-apiserver:v1.27.16
kube-controller-manager-master registry.aliyuncs.com/google_containers/kube-controller-manager:v1.27.16
kube-scheduler-master          registry.aliyuncs.com/google_containers/kube-scheduler:v1.27.16
~~~

然后看节点：

~~~bash
kubectl get nodes
~~~

仍然是：

~~~text
NAME     STATUS   ROLES           AGE    VERSION
master   Ready    control-plane   262d   v1.27.0
node1    Ready    worker          262d   v1.27.0
node2    Ready    worker          262d   v1.27.0
node3    Ready    worker          262d   v1.27.0
node4    Ready    worker          260d   v1.27.0
~~~

这是因为 `kubectl get nodes` 的 VERSION 显示的是 kubelet 版本。

### 证书也被自动续期

升级前：

~~~bash
kubeadm certs check-expiration
~~~

其中大部分非 CA 证书剩余：

~~~text
admin.conf                 Jan 13, 2027 05:58 UTC   102d
apiserver                  Jan 13, 2027 05:58 UTC   102d
apiserver-etcd-client      Jan 13, 2027 05:58 UTC   102d
...
scheduler.conf             Jan 13, 2027 05:58 UTC   102d
~~~

`kubeadm upgrade apply` 后再次检查：

~~~bash
kubeadm certs check-expiration
~~~

变成：

~~~text
admin.conf                 Oct 02, 2027 08:24 UTC   364d
apiserver                  Oct 02, 2027 08:22 UTC   364d
apiserver-etcd-client      Oct 02, 2027 08:22 UTC   364d
...
scheduler.conf             Oct 02, 2027 08:23 UTC   364d
~~~


### 更新 control-plane 的 kubelet 和 kubectl

`kubeadm upgrade apply` 完成后，control-plane 组件已经是 v1.27.16，但 `kubectl get nodes` 仍显示 master 的 kubelet 是 v1.27.0。

master 后续按维护顺序完成 drain。kubelet 和 kubectl 的 Linux amd64 v1.27.16 二进制从 Kubernetes 官方下载站获取，分别使用对应的 SHA256 文件校验后，安装到 `/usr/local/bin` 覆盖旧版本。重启 kubelet，检查版本和节点状态后，再将 master uncordon。

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

重启 kubelet，检查二进制版本和 master 节点状态：

~~~bash
systemctl restart kubelet
kubelet --version
kubectl version
kubectl get node master
~~~

确认节点已恢复 Ready 后，再 uncordon master：

~~~bash
kubectl uncordon master
~~~

最终的 `kubectl get nodes` 结果会在文末统一确认。

## 升级 worker 节点

control-plane 处理完后，再逐台升级 worker。worker 侧的基本顺序是：

~~~text
更新 kubeadm
→ kubeadm upgrade node
→ drain
→ 更新 kubelet
→ restart kubelet
→ 检查
→ uncordon
~~~

本次集群管理用的 `kubectl` 命令从 control-plane 节点执行。worker 侧只更新 kubeadm 和 kubelet，不需要在 worker 上安装或更新 kubectl。kubeadm 和 kubelet 的下载、SHA256 校验以及替换二进制的方式前文已经写过，这里不再重复展开。

各 worker 的重复步骤不再逐台展开，下面只记录 drain 过程中出现的差异。

### node1：第一次 drain 被 emptyDir 挡住

第一次执行：

~~~bash
kubectl drain node1 --ignore-daemonsets
~~~

返回：

~~~text
node/node1 cordoned
cannot delete Pods with local storage (use --delete-emptydir-data to override):
  kube-system/metrics-server-...
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...
~~~

`emptyDir` 是这次 `drain` 报错的直接原因。加上 `--delete-emptydir-data` 可以允许驱逐，但会丢弃这些 Pod 的本地临时数据。

node1 后续完成了 drain 和 kubelet 更新，检查到：

~~~text
NAME    STATUS                     ROLES    AGE    VERSION
node1   Ready,SchedulingDisabled   worker   262d   v1.27.16
~~~

当时 node1 上只剩下 Calico、kube-proxy、node-exporter 这类 DaemonSet Pod，然后再 uncordon。

### node2：允许删除 emptyDir 后，Prometheus PDB 又挡住 drain

node2 第一次 drain 同样遇到了前面的 `emptyDir` 限制。确认这些临时数据可以丢弃后，重试时直接带上 `--delete-emptydir-data`：

~~~bash
kubectl drain node2 --ignore-daemonsets --delete-emptydir-data
~~~

普通 Pod 开始被驱逐，但 `prometheus-k8s-0` 无法通过 eviction 离开节点，drain 会反复重试：

~~~text
evicting pod monitoring/prometheus-k8s-0
error when evicting pods/"prometheus-k8s-0" -n "monitoring" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
~~~

这里需要区分两层限制：`--delete-emptydir-data` 只是允许 drain 删除使用 `emptyDir` 的 Pod，它不会绕过 PodDisruptionBudget。继续检查 Prometheus 的 PDB：

~~~bash
kubectl -n monitoring get pdb prometheus-k8s -o wide
~~~

当时的状态是：

~~~text
NAME             MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-k8s   1               N/A               0
~~~

`ALLOWED DISRUPTIONS=0` 表示在当时的副本和 PDB 状态下，正常 eviction 不允许再中断这个 Pod。

在继续处理前，先把原 PDB 保存下来：

~~~bash
RUN_DIR=/root/k8s-upgrade-log/v1.27.0-to-v1.27.16

kubectl -n monitoring get pdb prometheus-k8s -o yaml \
  > "$RUN_DIR/48-prometheus-k8s-pdb-before.yaml"
~~~

PDB 只是解释了为什么正常 eviction 失败，还需要确认这个 Pod 被删除并重建后会不会丢数据。先检查 PVC、StorageClass 和 PV：

~~~bash
kubectl -n monitoring get pvc
kubectl get storageclass
kubectl get pv
~~~

当时的输出分别是：

~~~text
No resources found in monitoring namespace.
No resources found
No resources found
~~~

再直接检查 `prometheus-k8s-0` 的 volume：

~~~bash
kubectl -n monitoring get pod prometheus-k8s-0 \
  -o jsonpath='{range .spec.volumes[*]}{.name}{" => PVC="}{.persistentVolumeClaim.claimName}{" hostPath="}{.hostPath.path}{" emptyDir="}{.emptyDir}{"\n"}{end}'
~~~

数据库 volume 是：

~~~text
prometheus-k8s-db => PVC= hostPath= emptyDir={}
~~~

这说明当时的 Prometheus TSDB 没有使用 PVC，而是放在 Pod 的 `emptyDir` 中。也就是说，node2 上同时存在两个独立问题：PDB 阻止正常 eviction，而一旦删除并重建这个 Pod，原来的本地 TSDB 历史数据也不会跟着 Pod 一起迁移。

这个测试集群里采用的是临时放宽 PDB 的方式：先保存原 PDB，把 `prometheus-k8s` 的 `minAvailable` 从 `1` 临时改成 `0`，完成 node2 的 drain 后再恢复原 PDB。整个处理顺序是：

~~~text
保存原 PDB
→ 临时将 minAvailable: 1 调整为 0
→ 重新 drain node2
→ 完成节点维护
→ 恢复原 PDB
~~~

这里之所以能接受这种处理，是因为这是测试集群，而且已经确认 Prometheus TSDB 使用的是 `emptyDir`，本轮维护可以接受历史数据丢失。生产环境如果遇到同样的布局，应该先处理 Prometheus 的持久化和副本策略，再决定怎样调整 PDB，而不是直接放宽保护继续 drain。

### node3 和 node4：继续按相同方式处理 emptyDir

node3 和 node4 第一次执行 drain 时，也被使用 `emptyDir` 的 Pod 挡住：

~~~bash
kubectl drain node3 --ignore-daemonsets
kubectl drain node4 --ignore-daemonsets
~~~

两台节点都出现了同一类错误：

~~~text
cannot delete Pods with local storage (use --delete-emptydir-data to override):
~~~

确认这些临时数据可以丢弃后，重新执行：

~~~bash
kubectl drain node3 --ignore-daemonsets --delete-emptydir-data
kubectl drain node4 --ignore-daemonsets --delete-emptydir-data
~~~

drain 完成后，两台节点都处于 `SchedulingDisabled`，此时 kubelet 还没有更新，所以版本仍然是 v1.27.0：

~~~text
NAME    STATUS                     ROLES    AGE    VERSION
node3   Ready,SchedulingDisabled   worker   260d   v1.27.0
node4   Ready,SchedulingDisabled   worker   260d   v1.27.0
~~~

随后再继续更新各节点的 kubelet，检查节点恢复正常后执行 uncordon。最终状态见下一节。

## v1.27.16 最终状态

所有节点处理完以后：

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

第一阶段已经把二进制下载、SHA256 校验、etcd snapshot、control-plane 升级、worker drain、kubelet 更新和 PDB 处理完整走过一遍。进入 minor version 升级后，这些重复步骤不再逐项展开；备份和 etcd snapshot 继续沿用前文做法，本节只记录 v1.27.16 → v1.28.15 这一跳新增的变化、兼容性准备和最终验证。

### 升级 Kubernetes 前先处理 Calico

当前集群使用 manifest 部署的 Calico v3.25.0。目标 Kubernetes 是 v1.28.15，因此这次先把 Calico 升级到 v3.27.5，再升级 Kubernetes。

这不是 kubeadm 的硬性要求，也不表示 Calico v3.25.0 在 Kubernetes 1.28 上一定无法运行。这样安排的原因是 CNI 属于集群最基础的网络组件之一，而 Calico 每个版本都会针对一定范围的 Kubernetes 版本进行测试。先把 CNI 调整到更接近目标 Kubernetes 版本的版本，可以把网络组件变化和 Kubernetes control-plane 变化拆成两个阶段，减少后续出现网络问题时的排查变量。

这个集群还有一项不能丢的本地配置：

~~~yaml
- name: IP
  value: "autodetect"
- name: IP_AUTODETECTION_METHOD
  value: "can-reach=10.10.10.1"
~~~

先获取官方 v3.27.5 manifest，并复制一份用于保留当前集群的本地配置：

~~~bash
curl -LO \
  https://raw.githubusercontent.com/projectcalico/calico/v3.27.5/manifests/calico.yaml

cp calico.yaml calico-v3.27.5-custom.yaml
~~~

然后在 `calico-v3.27.5-custom.yaml` 中保留上面的 `IP` 和 `IP_AUTODETECTION_METHOD` 配置，再应用：

~~~bash
kubectl apply -f calico-v3.27.5-custom.yaml
~~~

等待两个组件完成 rollout：

~~~bash
kubectl -n kube-system rollout status daemonset/calico-node
kubectl -n kube-system rollout status deployment/calico-kube-controllers
~~~

升级完成后：

~~~text
calico-node                 5/5 Ready
calico-kube-controllers     1/1 Ready
Calico                      v3.27.5
~~~

再确认自定义自动探测方式仍然存在：

~~~bash
kubectl -n kube-system get daemonset calico-node \
  -o jsonpath='{range .spec.template.spec.containers[?(@.name=="calico-node")].env[*]}{.name}={.value}{"\n"}{end}' \
  | grep -E '^IP=|^IP_AUTODETECTION_METHOD='
~~~

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

Calico 稳定后再进入 Kubernetes v1.28.15 升级。

### 确认 v1.28.15 升级计划

control-plane 上的 kubeadm 更新到 v1.28.15 并完成 SHA256 校验后，执行：

~~~bash
kubeadm upgrade plan v1.28.15
~~~

这次实际计划是：

| 组件 | 当前版本 | 目标版本 |
| --- | --- | --- |
| kube-apiserver | v1.27.16 | v1.28.15 |
| kube-controller-manager | v1.27.16 | v1.28.15 |
| kube-scheduler | v1.27.16 | v1.28.15 |
| kube-proxy | v1.27.16 | v1.28.15 |
| CoreDNS | v1.10.1 | v1.10.1 |
| etcd | 3.5.12-0 | 3.5.15-0 |
| kubelet | 5 个节点均为 v1.27.16 | v1.28.15 |

### 升级 control-plane

正式升级前先做 dry-run：

~~~bash
kubeadm upgrade apply v1.28.15 --dry-run --yes
~~~

结束输出：

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

然后正式升级：

~~~bash
kubeadm upgrade apply v1.28.15 --yes
~~~

最终：

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.28.15". Enjoy!
~~~

此时 control-plane static Pod 和 etcd 已经切到目标版本，master 的 kubelet 仍然需要单独更新。

master 的 drain 继续沿用前文已经确认过的 emptyDir 处理方式，不再重复制造一次相同的失败：

~~~bash
kubectl drain master \
  --ignore-daemonsets \
  --delete-emptydir-data
~~~

随后按前文相同方式更新 kubelet 和 kubectl，重启 kubelet。检查到 master 为 `Ready,SchedulingDisabled` 且 kubelet 已经是 v1.28.15 后再执行：

~~~bash
kubectl uncordon master
~~~

### 逐台升级 worker

worker 仍然一台一台处理，基本顺序没有变化：

~~~text
更新 kubeadm
→ kubeadm upgrade node
→ drain
→ 更新 kubelet
→ restart kubelet
→ 检查
→ uncordon
~~~

这一轮四台 worker 的结果如下：

| 节点 | 升级结果 | 本轮差异 |
| --- | --- | --- |
| node1 | v1.28.15 / Ready | drain 再次被 Prometheus PDB 阻止 |
| node2 | v1.28.15 / Ready | 无新增问题 |
| node3 | v1.28.15 / Ready | 无新增问题 |
| node4 | v1.28.15 / Ready | drain 再次被 Prometheus PDB 阻止 |

node1 和 node4 遇到的仍然是前文已经分析过的同一个约束：

~~~text
Cannot evict pod as it would violate the pod's disruption budget.
~~~

因此这里不再重复解释 PDB 和 `emptyDir` 的关系，而是沿用前文已经验证过的处理方式：临时把 `prometheus-k8s` 的 `minAvailable` 从 `1` 调整为 `0`，完成 drain；待 `prometheus-k8s-0` 在其他节点恢复为 `2/2 Running` 后，再把 `minAvailable` 恢复为 `1`。

### v1.28.15 最终状态

所有节点完成后：

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

关键组件的最终版本：

| 组件 | 最终状态 |
| --- | --- |
| kube-apiserver | v1.28.15 |
| kube-controller-manager | v1.28.15 |
| kube-scheduler | v1.28.15 |
| etcd | 3.5.15-0 |
| CoreDNS | v1.10.1，2/2 Ready |
| kube-proxy | v1.28.15，5/5 Ready |
| Calico | v3.27.5，calico-node 5/5 Ready |
| Prometheus | 2/2 Running |
| Prometheus PDB | minAvailable=1 |

Calico 的本地自动探测配置也仍然保持：

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

API readiness：

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

最终：

~~~text
[+]ping ok
[+]etcd ok
[+]etcd-readiness ok
...
readyz check passed
~~~

同时检查所有 namespace 中没有异常状态的 Pod：

~~~bash
kubectl get pods -A --no-headers | \
  awk '$4 != "Running" && $4 != "Completed" {print}'
~~~

这次输出为空。

### 再从 Pod 内验证 DNS、Service 和 API

节点和 control-plane 都是 Ready 还不够，我最后又从普通 Pod 内验证了一次实际数据路径。

先验证集群 DNS：

~~~bash
kubectl run dns-smoke-test \
  --image=busybox:1.36 \
  --restart=Never \
  --command -- \
  nslookup kubernetes.default.svc.cluster.local

kubectl logs dns-smoke-test
~~~

解析结果：

~~~text
Server:  10.96.0.10
Name:    kubernetes.default.svc.cluster.local
Address: 10.96.0.1
~~~

然后用 curl 容器访问 Kubernetes API Service：

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

返回的版本信息包含：

~~~json
{
  "major": "1",
  "minor": "28",
  "gitVersion": "v1.28.15"
}
~~~

这一步把前面的状态检查再向前推进了一层：Pod 内 DNS 能解析 Service，Service ClusterIP 能到达 API Server，TLS CA 校验和 ServiceAccount 认证都能正常完成，API 最终返回 HTTP 200 和 v1.28.15 的版本信息。

测试完成后删除临时 Pod：

~~~bash
kubectl delete pod dns-smoke-test api-smoke-test
~~~

到这里，v1.27.16 → v1.28.15 这一阶段结束。

## v1.28.15 → v1.29.14

这一轮继续复用前面已经验证过的升级方法，不再重复二进制下载、SHA256 校验、etcd snapshot 和逐节点维护的基础步骤。这里重点记录 v1.29 这一跳新增的兼容性检查、upgrade plan 差异，以及最终验证。

### 升级前检查 v1.29 移除的 API

先检查 apiserver 是否实际观察到即将在 v1.29 被移除的 API 请求：

~~~bash
kubectl get --raw /metrics \
  | grep 'apiserver_requested_deprecated_apis' \
  | grep 'removed_release="1.29"' || true
~~~

这次没有输出。

再检查当前存储对象和几个老的 in-tree 存储字段：

~~~bash
kubectl get storageclass -o wide
kubectl get pv -o wide

kubectl get pv -o yaml \
  | grep -nE 'gcePersistentDisk:|rbd:|cephfs:' || true

kubectl get --raw /metrics \
  | grep '^apiserver_requested_deprecated_apis' || true
~~~

本次集群没有 StorageClass 和 PV，deprecated API 指标也没有输出。

### 用目标版本 kubeadm 重新确认 upgrade plan

这一轮有一个值得单独记录的差异。

最开始 control-plane 上仍然是 kubeadm v1.28.15。用它查看 v1.29.14 升级计划时，CoreDNS 和 etcd 的目标变化没有完整体现。随后先把 control-plane 上的 kubeadm 更新到 v1.29.14，再重新执行：

~~~bash
kubeadm upgrade plan v1.29.14
~~~

这次的结果才作为本轮最终计划：

| 组件 | 当前版本 | 目标版本 |
| --- | --- | --- |
| kube-apiserver | v1.28.15 | v1.29.14 |
| kube-controller-manager | v1.28.15 | v1.29.14 |
| kube-scheduler | v1.28.15 | v1.29.14 |
| kube-proxy | v1.28.15 | v1.29.14 |
| CoreDNS | v1.10.1 | v1.11.1 |
| etcd | 3.5.15-0 | 3.5.16-0 |
| kubelet | 5 个节点均为 v1.28.15 | v1.29.14 |

这次实际操作说明：跨 minor 升级时，最终的 upgrade plan 应以目标版本 kubeadm 生成的结果为准，而不是继续依赖旧版本 kubeadm 对目标版本的计划结果。

### dry-run 和 control-plane 升级

正式升级前先做 dry-run：

~~~bash
kubeadm upgrade apply v1.29.14 --dry-run --yes
~~~

结束输出：

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

然后执行正式升级：

~~~bash
kubeadm upgrade apply v1.29.14 --yes
~~~

结束输出：

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.29.14". Enjoy!
~~~

这一步完成后，control-plane static Pod、etcd、CoreDNS 和 kube-proxy 已经更新到计划中的目标版本。

实际检查到的关键版本：

| 组件 | 版本 / 状态 |
| --- | --- |
| kube-apiserver | v1.29.14 |
| kube-controller-manager | v1.29.14 |
| kube-scheduler | v1.29.14 |
| etcd | 3.5.16-0 |
| CoreDNS | v1.11.1 |
| kube-proxy | v1.29.14 |

随后更新 master 的 kubelet 和 kubectl，重启 kubelet，确认运行中的 kubelet 已经是 v1.29.14。节点恢复 Ready 后执行：

~~~bash
kubectl uncordon master
~~~

最终 master：

~~~text
master   Ready   control-plane   v1.29.14
~~~

### 逐台升级 worker

这一轮仍然逐台处理 worker。实际执行顺序是：

~~~text
drain
→ 更新 kubeadm
→ kubeadm upgrade node
→ 更新 kubelet
→ restart kubelet
→ 验证运行中的 kubelet
→ uncordon
~~~

每台 worker 的 \`kubeadm upgrade node\` 都返回：

~~~text
[upgrade] The configuration for this node was successfully updated!
~~~

四台 worker 最终都恢复到 Ready / v1.29.14。

node1 和 node4 在 drain 时再次遇到前面已经分析过的 Prometheus PDB：

~~~text
Cannot evict pod as it would violate the pod's disruption budget.
~~~

当时 \`prometheus-k8s\` 仍然是：

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

因此继续复用前面已经验证过的处理方式：临时把 \`minAvailable\` 从 1 改成 0，完成 drain；等待 \`prometheus-k8s-0\` 在其他节点恢复到 \`2/2 Running\` 后，再恢复：

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

node2 和 node3 本轮 drain 没有出现新的阻塞。

### 最终状态和功能验证

全部节点完成后：

~~~bash
kubectl get nodes -o wide
~~~

结果：

~~~text
NAME     STATUS   ROLES           VERSION
master   Ready    control-plane   v1.29.14
node1    Ready    worker          v1.29.14
node2    Ready    worker          v1.29.14
node3    Ready    worker          v1.29.14
node4    Ready    worker          v1.29.14
~~~

control-plane static Pod 全部 \`Running\`，CoreDNS 为 \`2/2\`，kube-proxy 为 \`5/5\`，Calico node 为 \`5/5\`。检查非正常 Pod：

~~~bash
kubectl get pods -A | \
  awk 'NR==1 || ($4!="Running" && $4!="Completed")'
~~~

除了表头外没有其他输出。

API readiness：

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

结束为：

~~~text
readyz check passed
~~~

Calico 继续保持 v3.27.5，本地 IP 自动探测配置也没有丢失：

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

这套集群的 \`metrics.k8s.io\` 实际由 \`monitoring/prometheus-adapter\` 提供。升级后：

~~~bash
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl top nodes
kubectl top pods -A
~~~

APIService 为 \`AVAILABLE=True\`，\`kubectl top\` 也能正常返回 CPU 和内存数据。

最后再从普通 Pod 内验证 DNS 和 Kubernetes API Service。

DNS：

~~~bash
kubectl run dns-smoke-test \
  --image=busybox:1.36 \
  --restart=Never \
  --command -- \
  sh -c 'nslookup kubernetes.default.svc.cluster.local'

kubectl logs dns-smoke-test
~~~

实际解析结果：

~~~text
Server:         10.96.0.10
Address:        10.96.0.10:53

Name:   kubernetes.default.svc.cluster.local
Address: 10.96.0.1
~~~

API：

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

返回：

~~~json
{
  "major": "1",
  "minor": "29",
  "gitVersion": "v1.29.14"
}
~~~

这说明升级后的 Pod DNS、Service ClusterIP、API TLS 校验、ServiceAccount 认证和 API server 访问都正常。

测试完成后删除临时 Pod：

~~~bash
kubectl delete pod api-smoke-test dns-smoke-test
~~~

到这里，v1.28.15 → v1.29.14 这一阶段结束。


## v1.29.14 → v1.30.14

这一轮继续复用前面已经验证过的下载、SHA256 校验和逐节点维护流程，只记录 v1.30 这次真正出现的新差异：先升级 Calico、upgrade plan 中出现 etcd patch 版本回退、显式跳过 etcd 升级，以及实际 drain 时再次遇到的 Prometheus PDB。

### 先把 Calico 升级到 v3.28.5

开始这一轮时，集群已经是 Kubernetes v1.29.14，Calico 是 v3.27.5。Kubernetes 本身升级前，我先把 Calico 更新到 v3.28.5，并继续保留这个集群原来的 IP 自动探测设置：

~~~yaml
- name: IP
  value: "autodetect"
- name: IP_AUTODETECTION_METHOD
  value: "can-reach=10.10.10.1"
~~~

先下载 v3.28.5 manifest，并基于它保留集群自己的配置：

~~~bash
curl -fL \
  https://raw.githubusercontent.com/projectcalico/calico/v3.28.5/manifests/calico.yaml \
  -o calico-v3.28.5.yaml

cp calico-v3.28.5.yaml calico-v3.28.5-custom.yaml
~~~

应用后等待两个 Calico workload 完成 rollout：

~~~bash
kubectl apply -f calico-v3.28.5-custom.yaml

kubectl -n kube-system rollout status daemonset/calico-node
kubectl -n kube-system rollout status deployment/calico-kube-controllers
~~~

最终状态是：

~~~text
calico-node                 5/5 Ready
calico-kube-controllers     1/1 Ready
Calico                      v3.28.5
~~~

自定义的 IP autodetection 也仍然存在：

~~~text
IP=autodetect
IP_AUTODETECTION_METHOD=can-reach=10.10.10.1
~~~

在继续 Kubernetes 升级前，我还从普通 Pod 里重新验证了 DNS 和 Kubernetes API Service，两个 smoke test 都通过。

### 目标版本 kubeadm 的 plan 暴露了 etcd patch 回退

control-plane 上的 kubeadm 更新到 v1.30.14 后，重新生成正式 upgrade plan：

~~~bash
kubeadm upgrade plan v1.30.14
~~~

实际计划是：

| 组件 | 当前版本 | 目标版本 |
| --- | --- | --- |
| kube-apiserver | v1.29.14 | v1.30.14 |
| kube-controller-manager | v1.29.14 | v1.30.14 |
| kube-scheduler | v1.29.14 | v1.30.14 |
| kube-proxy | v1.29.14 | v1.30.14 |
| CoreDNS | v1.11.1 | v1.11.3 |
| etcd | 3.5.16-0 | 3.5.15-0 |
| kubelet | 5 个节点均为 v1.29.14 | v1.30.14 |

这里最值得停下来看的不是 Kubernetes 组件，而是 etcd：

~~~text
3.5.16-0 → 3.5.15-0
~~~

也就是说，这次 kubeadm plan 给出的 etcd 目标 patch 比集群当前正在运行的版本更低。本次升级没有让 kubeadm 执行这个 etcd 变更，而是明确保留当前的 3.5.16-0。

### dry-run 时显式跳过 etcd

先执行：

~~~bash
kubeadm upgrade apply v1.30.14 \
  --dry-run \
  --yes \
  --etcd-upgrade=false
~~~

dry-run 结束为：

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

检查 dry-run 输出时，可以看到 kube-apiserver、kube-controller-manager 和 kube-scheduler 的新 static Pod manifest，CoreDNS 目标是 v1.11.3，kube-proxy 目标是 v1.30.14；没有出现写入新 etcd static Pod manifest 的步骤。

确认后执行正式升级：

~~~bash
kubeadm upgrade apply v1.30.14 \
  --yes \
  --etcd-upgrade=false
~~~

结果：

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.30.14". Enjoy!
~~~

升级后实际运行的关键版本是：

| 组件 | 实际版本 |
| --- | --- |
| kube-apiserver | v1.30.14 |
| kube-controller-manager | v1.30.14 |
| kube-scheduler | v1.30.14 |
| etcd | 3.5.16-0 |
| CoreDNS | v1.11.3 |
| kube-proxy | v1.30.14 |

这也直接确认了 etcd 没有跟着 plan 回到 3.5.15-0。

CoreDNS 和 kube-proxy 在 apply 结束后的短时间内仍在 rollout。我分别等待：

~~~bash
kubectl -n kube-system rollout status deployment/coredns --timeout=10m
kubectl -n kube-system rollout status daemonset/kube-proxy --timeout=10m
~~~

最终 CoreDNS 为 2/2，kube-proxy 为 5/5。

### 更新 master kubelet

master 先正常 drain：

~~~bash
kubectl drain master \
  --ignore-daemonsets \
  --delete-emptydir-data
~~~

然后把 kubelet 和 kubectl 更新到 v1.30.14，重启 kubelet，并同时检查磁盘上的二进制和实际运行进程：

~~~bash
kubelet --version
kubectl version --client

PID=$(pidof kubelet)
readlink -f /proc/$PID/exe
/proc/$PID/exe --version
~~~

两处 kubelet 都确认是：

~~~text
Kubernetes v1.30.14
~~~

这次重启 kubelet 后，紧接着执行的第一次 kubectl 请求短暂返回：

~~~text
The connection to the server 10.10.10.100:6443 was refused
~~~

没有立即改配置或回滚。随后检查本机状态时，6443 已经重新监听，etcd、kube-apiserver、kube-controller-manager 和 kube-scheduler 都是 Running。kubelet 日志也显示这些 static Pod 在重启后的十几秒内重新启动完成。

再次检查：

~~~bash
kubectl get node master -o wide
kubectl get --raw='/readyz?verbose'
~~~

master 已经是 `Ready,SchedulingDisabled / v1.30.14`，并且 readyz 全部通过，然后再：

~~~bash
kubectl uncordon master
~~~

### 逐台升级 worker

这一轮 worker 的实际顺序是：

~~~text
drain
→ update kubeadm
→ kubeadm upgrade node
→ update kubelet / kubectl
→ restart kubelet
→ verify the running kubelet
→ uncordon
~~~

node1 和 node2 都没有出现新的 drain 阻塞。

node3 drain 时，`prometheus-k8s-0` 实际触发了 PDB：

~~~text
Cannot evict pod as it would violate the pod's disruption budget.
~~~

当时的 PDB 是：

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

因此临时把 `prometheus-k8s` 的 `minAvailable` 从 1 改为 0，重新 drain node3。节点升级完成并 uncordon 后，先等 `prometheus-k8s-0` 在 node4 恢复到 `2/2 Running`，再把 PDB 恢复为 `minAvailable: 1`。

到 node4 时，同一个 Prometheus Pod 已经运行在 node4，所以 drain 又实际遇到了同一个 PDB 阻塞。处理方式相同：临时改为 0，完成 drain 和节点升级，uncordon node4；确认 Prometheus 已经在 node3 重新变成 `2/2 Running` 后，再恢复：

~~~text
MIN AVAILABLE        1
ALLOWED DISRUPTIONS  0
~~~

最终四个 worker 都是 `Ready / v1.30.14`。

### 最终状态和功能验证

全部节点完成后：

~~~text
NAME     STATUS   ROLES           VERSION
master   Ready    control-plane   v1.30.14
node1    Ready    worker          v1.30.14
node2    Ready    worker          v1.30.14
node3    Ready    worker          v1.30.14
node4    Ready    worker          v1.30.14
~~~

关键组件最终状态：

| 组件 | 最终状态 |
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

检查异常 Pod：

~~~bash
kubectl get pods -A \
  --field-selector=status.phase!=Running,status.phase!=Succeeded
~~~

返回：

~~~text
No resources found
~~~

API readiness：

~~~bash
kubectl get --raw='/readyz?verbose'
~~~

结束为：

~~~text
readyz check passed
~~~

这个集群的 `metrics.k8s.io` 仍由 `monitoring/prometheus-adapter` 提供。升级后 APIService 为 `AVAILABLE=True`，`kubectl top nodes` 也正常返回 5 个节点的 CPU 和内存数据。

最后再次从 Pod 内验证 DNS 和 Kubernetes API Service。

DNS：

~~~text
Server:         10.96.0.10
Address:        10.96.0.10:53

Name:   kubernetes.default.svc.cluster.local
Address: 10.96.0.1
~~~

API 返回：

~~~json
{
  "major": "1",
  "minor": "30",
  "gitVersion": "v1.30.14"
}
~~~

两个 smoke Pod 都以 `Completed` 结束并随后删除。

至此，v1.29.14 → v1.30.14 这一阶段完成。

### v1.30 之后继续升级

本文到 v1.30.14 为止，不再把后面的每一个 minor 版本继续塞进同一篇文章。后续从 v1.30 升级到更新版本，整体方法仍然沿用前面的流程：按 minor 版本逐级升级，每一跳都先使用目标版本 kubeadm 重新确认 upgrade plan，检查该版本的 API、CNI 和关键组件兼容性，先做 dry-run，再升级 control-plane，逐台 drain 和升级 worker，最后重新做 readiness、DNS、Service/API 和监控验证。

具体的组件目标版本和兼容性变化仍应以每一跳的目标版本文档和实际 `kubeadm upgrade plan` 为准，不能把本文某一跳的版本号直接套到后续版本。

## 参考资料

- <a href="https://kubernetes.io/zh-cn/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27</a>
- <a href="https://kubernetes.io/zh-cn/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes 补丁版本</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">升级 kubeadm 集群</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/upgrading-linux-nodes/" target="_blank" rel="noopener noreferrer">升级 Linux worker 节点</a>
- <a href="https://kubernetes.io/zh-cn/releases/version-skew-policy/" target="_blank" rel="noopener noreferrer">Kubernetes 版本偏差策略</a>
- <a href="https://kubernetes.io/zh-cn/docs/reference/config-api/kubeadm-config.v1beta3/" target="_blank" rel="noopener noreferrer">kubeadm 配置（v1beta3）</a>
- <a href="https://kubernetes.io/zh-cn/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain 参考</a>
- <a href="https://kubernetes.io/zh-cn/releases/1.28/" target="_blank" rel="noopener noreferrer">Kubernetes 1.28</a>
- <a href="https://kubernetes.io/zh-cn/releases/1.29/" target="_blank" rel="noopener noreferrer">Kubernetes 1.29</a>
- <a href="https://kubernetes.io/zh-cn/releases/1.30/" target="_blank" rel="noopener noreferrer">Kubernetes 1.30</a>
- <a href="https://docs.tigera.io/calico/latest/getting-started/kubernetes/requirements" target="_blank" rel="noopener noreferrer">Calico Kubernetes 系统要求</a>
