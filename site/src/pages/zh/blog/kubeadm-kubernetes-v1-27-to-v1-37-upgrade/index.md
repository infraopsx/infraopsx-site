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
| Kubernetes 二进制 | 手工放在 `/usr/local/bin` |

3 个 control-plane 的 HA 集群在 control-plane 升级顺序、etcd 拓扑、负载均衡和可用性检查上会不同，因此不能把本文 control-plane 操作部分机械照搬到 HA 集群。

## 为什么第一步是 v1.27.16

Kubernetes 版本号可以直接拆成：

~~~text
v1.27.16
  │  │  └─ patch: 16
  │  └──── minor: 27
  └─────── major: 1
~~~

当前集群是 `v1.27.0`。这次先不跨到 1.28，而是先把 1.27.0 补到 1.27 系列最后一个 patch：`v1.27.16`。

Kubernetes 官方发布记录显示，1.27 系列的 final patch 是 1.27.16。kubeadm 升级也不支持跳过 minor version，所以后面的路线会按 1.28、1.29……逐个 minor 往前走。

~~~text
1.27.0
→ 1.27.16
→ 1.28.x
→ 1.29.x
→ ...
→ 1.37.x
~~~

这里不是说“升级到 1.28 前必须先到 1.27.16”。选择 1.27.16 只是为了先把当前 1.27 系列补到最后一个 patch，再开始跨 minor。

参考：

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

这里只记录升级前检查到的实际状态：三个二进制都在 `/usr/local/bin`，kubelet 的 systemd service 也从这个路径启动。本文不推断这个集群最初是怎样安装出来的；这次升级按现有路径直接替换二进制。

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

同时保存 Kubernetes 和 kubelet 配置：

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

## 先更新 kubeadm 工具，再执行 upgrade plan

这一步只更新 control-plane 节点上的 kubeadm 工具本身，集群还没有开始升级。

这批日志没有保留下当时下载 kubeadm 的那条命令，所以这里不补写一个“看起来像原始输入”的 curl/wget 命令。可以确认的是：目标二进制是 `v1.27.16`，下载后做了 SHA256 校验，然后替换现有的 `/usr/local/bin/kubeadm`。

校验记录：

~~~text
kubeadm-v1.27.16: OK
33622018f83515331ac70c2041eba5d814a6d78a40b8869f089ea502f63a1421  kubeadm-v1.27.16
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

因此此时执行 plan 仍然成立：

~~~bash
kubeadm upgrade plan
~~~

它检查的是“当前 v1.27.0 集群，如果使用 v1.27.16 的 kubeadm 去升级，会改哪些组件”。

关键输出：

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

在替换 kubeadm 之前，旧的 `v1.27.0` kubeadm 曾执行：

~~~bash
kubeadm config images list \
  --kubernetes-version v1.27.16 \
  --image-repository registry.aliyuncs.com/google_containers
~~~

当时出现 fallback：

~~~text
could not find officially supported version of etcd for Kubernetes v1.27.16,
falling back to the nearest etcd version (3.5.7-0)
...
registry.aliyuncs.com/google_containers/etcd:3.5.7-0
~~~

而目标版本 kubeadm 的 upgrade plan 给出的 etcd 目标是 `3.5.12-0`。所以后面的升级判断以目标版本 kubeadm 的 `upgrade plan` 为准。

## 升级 control-plane

先做 dry-run：

~~~bash
kubeadm upgrade apply v1.27.16 --dry-run
~~~

dry-run 正常后再执行：

~~~bash
kubeadm upgrade apply v1.27.16 --yes
~~~

结束时的关键输出：

~~~text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.27.16". Enjoy!

[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven't already done so.
kubeadm upgrade apply exit code: 0
~~~

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

control-plane 的 kubelet 更新到 v1.27.16 后，再逐台处理 worker。每台 worker 的顺序基本相同：

~~~text
替换 kubeadm / kubectl
→ kubeadm upgrade node
→ drain
→ 替换 kubelet
→ restart kubelet
→ 验证
→ uncordon
~~~

真正花时间的是 drain。

### node1：emptyDir 和 PDB

第一次：

~~~bash
kubectl drain node1 --ignore-daemonsets --timeout=5m
~~~

失败：

~~~text
node/node1 cordoned
cannot delete Pods with local storage (use --delete-emptydir-data to override):
  kube-system/metrics-server-...
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...

drain exit code: 1
~~~

确认这些 local storage 是可以接受丢失的 `emptyDir` 后，重试时加 `--delete-emptydir-data`。

接着又被 prometheus-adapter 的 PDB 挡住。检查：

~~~bash
kubectl -n monitoring get pdb prometheus-adapter -o wide
~~~

当时是：

~~~text
NAME                 MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-adapter   1               N/A               0
~~~

prometheus-adapter 只有 1 个副本，`minAvailable: 1`，所以没有可用的 voluntary disruption。

这个测试环境里临时把 prometheus-adapter 扩到 2 个副本，等第二个副本 Ready 后再 drain。

node3、node4 后面也遇到了类似情况，因为前一台节点上的 Pod 被驱逐后会重新调度到还没维护的节点。

### node2：Prometheus 没有持久化

node2 最后处理，因为上面有：

~~~text
prometheus-k8s-0
~~~

先看 PDB：

~~~bash
kubectl -n monitoring get pdb prometheus-k8s -o wide
~~~

~~~text
NAME             MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
prometheus-k8s   1               N/A               0
~~~

再看存储：

~~~bash
kubectl -n monitoring get pvc
kubectl get storageclass
kubectl get pv
~~~

输出都是：

~~~text
No resources found
~~~

继续看 Pod volume，发现：

~~~text
prometheus-k8s-db => emptyDir={}
~~~

也就是说当前 Prometheus TSDB 没有 persistent storage。这个测试集群可以接受 drain 后丢掉历史数据，所以先保存原 PDB，再临时把 `minAvailable` 从 1 改成 0，完成 drain 后恢复。

生产环境遇到这种情况，我不会直接继续 drain，而是先处理 Prometheus persistence。

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

第一阶段到这里结束。下一步是：

~~~text
v1.27.16 → v1.28.15
~~~

后面的版本也会继续保留同样的记录方式：只放有判断价值的命令和裁剪后的输出，不把整份终端日志原样贴进正文。

## 参考资料

- <a href="https://kubernetes.io/zh-cn/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes 补丁版本</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">升级 kubeadm 集群</a>
- <a href="https://kubernetes.io/zh-cn/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain 参考</a>
