---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes v1.27 到 v1.37：一次 kubeadm 集群升级记录"
description: "记录一个 5 节点 kubeadm 集群从 Kubernetes v1.27 逐步升级到 v1.37。第一部分是 v1.27.0 到 v1.27.16，包括备份、etcd、drain、PDB 和最终验证。"
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

Kubernetes 官方发布记录显示，1.27 系列最后一个 patch 版本是 1.27.16。kubeadm 不支持跳过 minor 版本升级，例如不能从 1.27 直接跳到 1.29，所以后面的路线会按 1.28、1.29……逐个 minor 往前走。

~~~text
1.27.0
→ 1.27.16
→ 1.28.x
→ 1.29.x
→ ...
→ 1.37.x
~~~

1.27.16 并不是升级到 1.28 的硬性前置条件。这里选择它，是为了先把 1.27 系列补到最后一个 patch，再开始跨 minor。

参考：

- <a href="https://kubernetes.io/zh-cn/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27</a>
- <a href="https://kubernetes.io/zh-cn/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes 补丁版本</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">升级 kubeadm 集群</a>

## 升级前检查

先看节点：

~~~bash
kubectl get nodes -o wide
~~~

当时的输出：

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

裁剪后的输出：

~~~text
/usr/local/bin/kubeadm
/usr/local/bin/kubelet
/usr/local/bin/kubectl

[Service]
ExecStart=/usr/local/bin/kubelet
...
ExecStart=/usr/local/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
~~~

升级前实际检查到的三个二进制都在 `/usr/local/bin`，kubelet 的 systemd service 也从这个路径启动，因此这次升级按现有路径替换二进制。

升级前 API readiness 正常：

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

先生成本次 checkpoint 的目录和 snapshot 文件名：

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

先保存当前三个二进制并记录 SHA256：

~~~bash
cp -a /usr/local/bin/kubeadm "$BACKUP_DIR/bin/"
cp -a /usr/local/bin/kubelet "$BACKUP_DIR/bin/"
cp -a /usr/local/bin/kubectl "$BACKUP_DIR/bin/"

sha256sum \
  "$BACKUP_DIR/bin/kubeadm" \
  "$BACKUP_DIR/bin/kubelet" \
  "$BACKUP_DIR/bin/kubectl"
~~~

同时保存 kubeadm/kubelet 配置和当前 workload 状态：

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

tar -czf "$BACKUP_DIR/etc-kubernetes.tar.gz" \
  /etc/kubernetes

tar -czf "$BACKUP_DIR/kubelet-config.tar.gz" \
  /lib/systemd/system/kubelet.service \
  /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf \
  /var/lib/kubelet/config.yaml \
  /var/lib/kubelet/kubeadm-flags.env
~~~

etcd snapshot 前先检查 endpoint：

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  endpoint health -w table
~~~

输出：

~~~text
+------------------------+--------+------------+-------+
|        ENDPOINT        | HEALTH |    TOOK    | ERROR |
+------------------------+--------+------------+-------+
| https://127.0.0.1:2379 |   true | 7.597329ms |       |
+------------------------+--------+------------+-------+
~~~

然后创建 snapshot：

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

这里的 `/var/lib/etcd/...` 是 snapshot 刚创建时的位置。随后把它复制进本次 checkpoint 目录：

~~~bash
cp -a "/var/lib/etcd/$SNAP" "$BACKUP_DIR/etcd/"
~~~

所以最后检查的备份文件是：

~~~text
/root/k8s-upgrade-backup/20261002-155639-before-v1.27.16/etcd/etcd-before-v1.27.16-20261002-155639.db
~~~

再检查 snapshot 内容：

~~~bash
kubectl -n kube-system exec etcd-master -- \
  etcdctl snapshot status "/var/lib/etcd/$SNAP" -w table
~~~

当前 etcd 镜像里没有 `etcdutl`，因此实际回退到了 `etcdctl snapshot status`：

~~~text
Deprecated: Use `etcdutl snapshot status` instead.

+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| 4d3d67ac | 38602084 |       1182 |      19 MB |
+----------+----------+------------+------------+
~~~

复制到 checkpoint 后再做 SHA256：

~~~bash
sha256sum "$BACKUP_DIR/etcd/$SNAP"
~~~

~~~text
128caa1e419caffa7ea030e850dfd3bfa01105e5622338bb6a27dc8ffd82f967  /root/k8s-upgrade-backup/20261002-155639-before-v1.27.16/etcd/etcd-before-v1.27.16-20261002-155639.db
~~~

最后对整个 checkpoint 生成并验证校验清单：

~~~bash
(
  cd "$BACKUP_DIR"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > SHA256SUMS
)

cd "$BACKUP_DIR"
sha256sum -c SHA256SUMS
~~~

裁剪后的结果：

~~~text
./bin/kubeadm: OK
./bin/kubectl: OK
./bin/kubelet: OK
./config/kubeadm-config.yaml: OK
./config/kubelet-config.yaml: OK
./config/nodes.yaml: OK
./config/workloads.yaml: OK
./etc-kubernetes.tar.gz: OK
./etcd/etcd-before-v1.27.16-20261002-155639.db: OK
./kubelet-config.tar.gz: OK
~~~

在替换 kubeadm 之前，先用当前的 `kubeadm v1.27.0` 查看一次 v1.27.16 对应镜像：

~~~bash
kubeadm config images list \
  --kubernetes-version v1.27.16 \
  --image-repository registry.aliyuncs.com/google_containers
~~~

其中 etcd 出现了 fallback：

~~~text
could not find officially supported version of etcd for Kubernetes v1.27.16,
falling back to the nearest etcd version (3.5.7-0)
...
registry.aliyuncs.com/google_containers/etcd:3.5.7-0
~~~

## 先更新 kubeadm 工具，再执行 upgrade plan

这一步只更新 control-plane 节点上的 kubeadm 工具本身，集群还没有开始升级。

当时先下载目标版本 kubeadm 和官方 SHA256 文件：

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
33622018f83515331ac70c2041eba5d814a6d78a40b8869f089ea502f63a1421  kubeadm-v1.27.16
~~~

然后替换 kubeadm：

~~~bash
install -o root -g root -m 0755 \
  "/tmp/kubeadm-${TARGET}" \
  /usr/local/bin/kubeadm
~~~

替换后先确认工具版本和集群版本：

~~~bash
kubeadm version -o short
kubectl version
~~~

裁剪后的输出：

~~~text
v1.27.16
...
Server Version: ... GitVersion:"v1.27.0" ...
~~~

这里的两个版本并不冲突：

- `kubeadm v1.27.16`：刚刚替换的是本机升级工具；
- `Server v1.27.0`：集群 control-plane 还没有执行 `kubeadm upgrade apply`。

确认本机 kubeadm 已经是 v1.27.16，而集群仍然是 v1.27.0 后，生成升级计划：

~~~bash
kubeadm upgrade plan "$TARGET"
~~~

plan 原始输出较长。下面不是 kubeadm 的原样输出，而是根据当时 plan 中显示的版本信息整理：

| 组件 | 当前版本 | 目标版本 |
| --- | --- | --- |
| kube-apiserver | v1.27.0 | v1.27.16 |
| kube-controller-manager | v1.27.0 | v1.27.16 |
| kube-scheduler | v1.27.0 | v1.27.16 |
| kube-proxy | v1.27.0 | v1.27.16 |
| CoreDNS | v1.10.1 | v1.10.1 |
| etcd | 3.5.7-0 | 3.5.12-0 |
| kubelet | 5 × v1.27.0 | v1.27.16（需要后续逐节点升级） |

这里和前面旧 kubeadm 的 `config images list` 有一个明显差异：旧 kubeadm 对 v1.27.16 的 etcd 映射 fallback 到 3.5.7-0，而 v1.27.16 kubeadm 的 upgrade plan 给出的目标是 3.5.12-0。后续以目标版本 kubeadm 的 upgrade plan 为准。

## 升级 control-plane

执行 apply 前，再确认 kubeadm 保存的 ClusterConfiguration：

~~~bash
kubectl -n kube-system get cm kubeadm-config \
  -o jsonpath='{.data.ClusterConfiguration}'
~~~

其中和镜像仓库有关的配置是：

~~~yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
imageRepository: registry.aliyuncs.com/google_containers
kubernetesVersion: v1.27.0
~~~

所以后面的 `kubeadm upgrade apply` 没有再单独写 `--image-repository`。kubeadm upgrade 会读取集群里的 `kubeadm-config`；这个集群已经把 `imageRepository` 配成了 `registry.aliyuncs.com/google_containers`。如果没有这个自定义配置，kubeadm 默认使用 `registry.k8s.io`。

先做 dry-run：

~~~bash
kubeadm upgrade apply v1.27.16 --dry-run
~~~

dry-run 的 kubeadm 结束输出是：

~~~text
[upgrade/successful] Finished dryrunning successfully!
~~~

命令返回码另外由 shell 记录为 `0`；这不是 kubeadm 自己打印的内容。

然后再执行：

~~~bash
kubeadm upgrade apply v1.27.16 --yes
~~~

kubeadm 结束时的关键输出：

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.27.16". Enjoy!

[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven't already done so.
~~~

这次 apply 的命令返回码同样由 shell 另外记录，结果为 `0`。

这时 control-plane static Pod 和 etcd 已经更新，但 kubelet 还没更新。

例如组件镜像已经变成：

~~~text
etcd-master                       registry.aliyuncs.com/google_containers/etcd:3.5.12-0
kube-apiserver-master             registry.aliyuncs.com/google_containers/kube-apiserver:v1.27.16
kube-controller-manager-master    registry.aliyuncs.com/google_containers/kube-controller-manager:v1.27.16
kube-scheduler-master             registry.aliyuncs.com/google_containers/kube-scheduler:v1.27.16
~~~

但此时再看节点：

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

### 更新 control-plane 的 kubelet 和 kubectl

`kubeadm upgrade apply` 完成后，control-plane 组件已经是 v1.27.16，但 master 节点的 kubelet 还是 v1.27.0。

先 drain master：

~~~bash
kubectl drain master --ignore-daemonsets
~~~

目标版本的 kubelet 和 kubectl 已经提前下载并完成校验，随后替换 `/usr/local/bin/kubelet` 和 `/usr/local/bin/kubectl`，再重启 kubelet：

~~~bash
systemctl daemon-reload
systemctl restart kubelet
~~~

检查 master：

~~~bash
kubectl get node master
~~~

当时已经变成：

~~~text
NAME     STATUS                     ROLES           AGE    VERSION
master   Ready,SchedulingDisabled   control-plane   262d   v1.27.16
~~~

确认 API readiness 正常后：

~~~bash
kubectl uncordon master
~~~

此时才完成 master 节点自身的 kubelet 升级。

### 证书也被续期

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

## 升级 kubelet 和 worker

control-plane 处理完后，再逐台升级 worker。worker 侧的基本顺序是：

~~~text
更新 kubeadm / kubectl
→ kubeadm upgrade node
→ drain
→ 更新 kubelet
→ restart kubelet
→ 检查
→ uncordon
~~~

各 worker 的重复步骤不再逐台展开，下面只记录 drain 过程中出现的差异。

### node1：第一次 drain 被 emptyDir 挡住

第一次执行：

~~~bash
kubectl drain node1 --ignore-daemonsets --timeout=5m
~~~

返回：

~~~text
node/node1 cordoned
cannot delete Pods with local storage (use --delete-emptydir-data to override):
  kube-system/metrics-server-...
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...

drain exit code: 1
~~~

随后检查 prometheus-adapter 的 PDB：

~~~bash
kubectl -n monitoring get pdb prometheus-adapter -o wide
kubectl -n monitoring describe pdb prometheus-adapter
~~~

当时的关键状态：

~~~text
NAME                 MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-adapter   1               N/A               0

Min available:        1
Allowed disruptions: 0
Current:             1
Desired:             1
Total:               1
~~~

因此这里实际上有两个独立问题：Pod 使用了 local `emptyDir`，同时 prometheus-adapter 的 PDB 也不允许驱逐当前唯一副本。

后续 node1 完成 drain 和 kubelet 更新后，检查到：

~~~text
NAME    STATUS                     ROLES    AGE    VERSION
node1   Ready,SchedulingDisabled   worker   262d   v1.27.16
~~~

当时 node1 上只剩下 Calico、kube-proxy、node-exporter 这类 DaemonSet Pod，然后再 uncordon。

### node3 和 node4：相同 blocker 会跟着 Pod 移动

node3 第一次 drain 也没有一次成功：

~~~bash
kubectl drain node3 --ignore-daemonsets --timeout=5m
~~~

裁剪后的输出：

~~~text
node/node3 cordoned
cannot delete Pods with local storage:
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...

drain exit code: 1
~~~

到了 node4，第一次 drain 又出现了同类情况：

~~~bash
kubectl drain node4 --ignore-daemonsets --timeout=5m
~~~

当时回传的输出在错误信息后被截断，但能确认 blocker 包括：

~~~text
kube-system/metrics-server-...
monitoring/prometheus-adapter-...
~~~

处理后检查 node4：

~~~text
NAME    STATUS                     ROLES    AGE    VERSION
node4   Ready,SchedulingDisabled   worker   260d   v1.27.0
~~~

而 node4 上只剩：

~~~text
calico-node-...
kube-proxy-...
node-exporter-...
~~~

后续 node4 的 kubelet 也完成了更新；在处理 node2 前再次检查集群时，node4 已经是 `Ready v1.27.16`。

这些输出说明，前一台节点上的 Pod 被驱逐后会被重新调度到其他尚未维护的节点，所以后面的 drain 可能再次遇到相同 blocker。

### node2：先确认 Prometheus 的数据放在哪里

node2 最后处理。升级前，`prometheus-k8s-0` 正在 node2 上运行。

先看 PDB：

~~~bash
kubectl -n monitoring get pdb prometheus-k8s -o wide
~~~

~~~text
NAME             MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-k8s   1               N/A               0
~~~

再看存储资源：

~~~bash
kubectl -n monitoring get pvc
kubectl get storageclass
kubectl get pv
~~~

结果都没有资源。

继续检查 Prometheus Pod 的 volume，看到：

~~~text
prometheus-k8s-db => emptyDir={}
~~~

所以这个 Prometheus 的 TSDB 当时并没有放在 PVC 上，而是在 `emptyDir`。如果这个 Pod 在 drain 过程中被删除并重新创建，原来的历史数据不会跟着 Pod 一起迁移。

这里先保存了原 PDB。当时本轮日志目录是：

~~~bash
RUN_DIR=/root/k8s-upgrade-log/v1.27.0-to-v1.27.16

kubectl -n monitoring get pdb prometheus-k8s -o yaml \
  > "$RUN_DIR/48-prometheus-k8s-pdb-before.yaml"
~~~

后续 node2 完成了升级，最终节点状态见下一节。

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

再检查异常 Pod 和 API readiness：

~~~bash
kubectl get pods -A \
  --field-selector=status.phase!=Running,status.phase!=Succeeded \
  -o wide

kubectl get --raw='/readyz?verbose'
~~~

裁剪后的结果：

~~~text
No resources found

[+]ping ok
[+]etcd ok
[+]etcd-readiness ok
...
readyz check passed
~~~

第一阶段到这里结束。下一步是：

~~~text
v1.27.16 → v1.28.15
~~~

## 参考资料

- <a href="https://kubernetes.io/zh-cn/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes 补丁版本</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">升级 kubeadm 集群</a>
- <a href="https://kubernetes.io/zh-cn/docs/reference/setup-tools/kubeadm/kubeadm-config/" target="_blank" rel="noopener noreferrer">kubeadm 配置</a>
- <a href="https://kubernetes.io/zh-cn/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain 参考</a>
