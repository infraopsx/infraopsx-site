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

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch releases</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>

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

这 3 个二进制不是 apt 管理，而是：

~~~text
/usr/local/bin/kubeadm
/usr/local/bin/kubelet
/usr/local/bin/kubectl
~~~

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

当时已经存在 `DNSConfigForming` Warning，所以后面再看到这类 Warning 时不能直接归因于升级。

## 先做备份和 etcd snapshot

备份目录：

~~~text
/root/k8s-upgrade-backup/20261002-155639-before-v1.27.16
~~~

里面保存了原来的 kubeadm、kubelet、kubectl、kubeadm 配置、kubelet 配置、`/etc/kubernetes` 和 etcd snapshot。

snapshot 保存后检查状态：

~~~bash
kubectl -n kube-system exec etcd-master --   etcdctl snapshot status /var/lib/etcd/etcd-before-v1.27.16-20261002-155639.db -w table
~~~

当前 etcd 镜像里没有 `etcdutl`，所以这里回退到了 `etcdctl snapshot status`：

~~~text
Deprecated: Use `etcdutl snapshot status` instead.

+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| 4d3d67ac | 38602084 |       1182 |      19 MB |
+----------+----------+------------+------------+
~~~

snapshot 另外做了 SHA256：

~~~text
128caa1e419caffa7ea030e850dfd3bfa01105e5622338bb6a27dc8ffd82f967
~~~

`/etc/kubernetes` 备份里包含 PKI 私钥，所以这类备份只用于恢复，不应该上传到公开附件或 GitHub。

## 先升级 kubeadm，再看 upgrade plan

这个集群是手工管理二进制，所以先只替换 kubeadm 到 `v1.27.16`，kubelet 暂时不动。

替换后确认：

~~~bash
kubeadm version -o short
~~~

~~~text
v1.27.16
~~~

然后再执行：

~~~bash
kubeadm upgrade plan
~~~

plan 里最关键的是目标组件版本：

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

这里也解释了为什么不能只靠旧的 `kubeadm v1.27.0` 去判断目标 patch 的组件映射。旧 kubeadm 之前查询 `v1.27.16` 时，etcd 仍然落到了 3.5.7-0；换成目标版本 kubeadm 后，plan 给出的目标是 3.5.12-0。

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

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch releases</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain</a>
