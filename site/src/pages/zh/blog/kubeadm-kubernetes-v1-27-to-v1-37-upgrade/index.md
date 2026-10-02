---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes v1.27 到 v1.37：一次真实的 kubeadm 集群升级记录"
description: "真实记录一个 5 节点 kubeadm 集群从 Kubernetes v1.27 逐步升级到 v1.37，包括备份、etcd 变化、drain 失败、PDB 阻塞和逐阶段验证。"
pubDate: "2026-10-02"
category: Kubernetes
tags:
  - Kubernetes
  - kubeadm
  - Upgrade
  - Cluster Maintenance
  - PodDisruptionBudget
  - etcd
  - Troubleshooting
enPath: "/blog/kubeadm-kubernetes-v1-27-to-v1-37-upgrade/"
zhPath: "/zh/blog/kubeadm-kubernetes-v1-27-to-v1-37-upgrade/"
---

这不是一篇按官方文档重新整理出来的 kubeadm 教程，而是一份真实升级记录。

## 升级计划与环境

| 环境 | 实际情况 |
| --- | --- |
| 集群拓扑 | 1 个 control-plane + 4 个 worker |
| control-plane 高可用 | 否，单 control-plane |
| 操作系统 | Debian 12 |
| Kernel | 6.1.0-52-amd64 |
| Container Runtime | containerd 1.6.20 |
| 起始版本 | Kubernetes v1.27.0 |
| Kubernetes 二进制 | 手工管理，位于 /usr/local/bin |
| 长期目标 | Kubernetes v1.37 |

本文记录的是**单 control-plane** kubeadm 集群。常见的 3 control-plane HA 集群，在 control-plane 升级顺序、负载均衡、etcd 拓扑和控制平面可用性验证上会有所不同，因此不能把本文 control-plane 部分机械照搬到 HA 集群。worker 侧的很多现象仍然具有参考价值。

这个集群已经运行了大约 260 天，起点是 Kubernetes <code>v1.27.0</code>。长期目标是把它一步一步升级到当前版本，并且不跳过 minor version。本文第一部分只记录第一个检查点：

~~~text
v1.27.0
  ↓
v1.27.16
~~~

看起来只是同一个 minor version 内的 patch 升级，但这是有意为之。

在进入 <code>v1.28</code> 之前，我先把整个集群统一升级到 <code>v1.27.16</code>。原因是：<code>v1.27.16</code> 是 Kubernetes 1.27 系列的**最终补丁版本**，而 Kubernetes 1.27 已经停止支持。另一方面，kubeadm 官方明确说明：升级时**不支持跳过 minor version**。

因此这次迁移路线是：

~~~text
1.27.0
→ 1.27.16
→ 1.28.x
→ 1.29.x
→ ...
→ 1.37.x
~~~

这里需要说明：kubeadm 并没有规定“从 1.27.0 升 1.28 之前必须先停在 1.27.16”。我选择先到 1.27.16，是为了在跨 minor version 之前先建立一个完全补齐当前 minor patch 的干净检查点，尽量减少变量。

## Checkpoint 1：v1.27.0 → v1.27.16

### 快速答案：为什么第一步先到 v1.27.16？

因为当前集群起点是 <code>v1.27.0</code>，而 <code>v1.27.16</code> 是 1.27 系列的最终 patch。Kubernetes 并不强制要求必须先经过这个 patch 才能进入 1.28，但官方建议尽快使用当前 minor 的最新 patch，同时 kubeadm 升级不支持跳过 minor version。

所以这次把 <code>v1.27.16</code> 作为第一个 checkpoint，是一个偏保守的做法：先把 1.27 内部能收敛的差异收敛掉，再跨到 1.28。

官方参考：

- <a href="https://kubernetes.io/zh-cn/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes 补丁版本历史</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">升级 kubeadm 集群</a>
- <a href="https://kubernetes.io/releases/version-skew-policy/" target="_blank" rel="noopener noreferrer">Kubernetes Version Skew Policy</a>

### v1.27.16 这个版本号是怎么确定的？

这个版本不是从博客、论坛或某个软件仓库列表里随便选出来的。

Kubernetes 官方 release history 明确显示：

~~~text
Kubernetes 1.27
Final patch release: 1.27.16
End of life: 2024-07-16
~~~

并且在我先把 kubeadm 二进制替换成 <code>v1.27.16</code> 后，真实执行 <code>kubeadm upgrade plan</code> 时，集群也再次确认：

~~~text
[upgrade/versions] Cluster version: v1.27.0
[upgrade/versions] kubeadm version: v1.27.16
[upgrade/versions] Target version: v1.27.16
[upgrade/versions] Latest version in the v1.27 series: v1.27.16
~~~

也就是说，这里有两个独立依据：

1. Kubernetes 官方发布历史；
2. 目标版本 kubeadm 自己给出的 upgrade plan。

这里还出现了一个很有价值的细节。

在升级 kubeadm 之前，我曾经用旧的 <code>v1.27.0</code> kubeadm 去查看 <code>v1.27.16</code> 对应的组件映射，旧 kubeadm 对目标 etcd 版本给出了 fallback。等 kubeadm 本身升级到 <code>v1.27.16</code> 后，<code>kubeadm upgrade plan</code> 才正确给出：

~~~text
etcd 3.5.7-0 → 3.5.12-0
~~~

所以对于一个很旧的集群，我不会把旧 kubeadm 对“未来 patch 版本组件映射”的判断当作最终依据。先升级 kubeadm，再用目标版本 kubeadm 做 plan，更可靠。

### 升级前的集群状态

这是一个 5 节点 kubeadm 集群：

| Node | Role | Kubernetes | OS | Runtime |
| --- | --- | --- | --- | --- |
| master | control-plane | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node1 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node2 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node3 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node4 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |

所有节点内核都是：

~~~text
6.1.0-52-amd64
~~~

Kubernetes 三个核心二进制并不是 apt 管理，而是手工放在：

~~~text
/usr/local/bin/kubeadm
/usr/local/bin/kubelet
/usr/local/bin/kubectl
~~~

systemd 的 kubelet 也是直接执行：

~~~text
/usr/local/bin/kubelet
~~~

这点很重要，因为官方 kubeadm 升级文档大多用 apt / dnf 举例。这个集群的 kubeadm 升级逻辑相同，但二进制替换、校验和回滚都必须手工处理。

其他关键基线：

~~~text
CNI: Calico v3.25.0（manifest 安装）
CoreDNS: v1.10.1
etcd: 3.5.7-0
containerd: 1.6.20
control-plane: 1
worker: 4
~~~

升级前 5 个节点全部是 Ready，API 的 <code>/readyz?verbose</code> 检查通过。

另外，升级前就已经存在一些 <code>DNSConfigForming</code> Warning。这些 warning 来自主机 resolver 配置，所以我在正式升级前先记录下来，避免升级后把已有问题误认为升级引入的新问题。

### 真正第一步不是升级，而是做恢复点

这次第一步不是下载 Kubernetes，而是先做恢复点。

这个测试集群里，我把恢复点保存在 control-plane 本机。对于生产集群或有价值的数据环境，我会再额外复制到另一台机器或对象存储，避免“备份和故障机器在一起”。

恢复内容包括：

- 原来的 kubeadm / kubelet / kubectl 二进制
- kubeadm-config
- kubelet 配置
- Node / workload 清单
- <code>/etc/kubernetes</code>
- kubelet 配置文件
- etcd snapshot
- 各备份文件 SHA256

etcd snapshot 成功完成，当时记录到：

~~~text
revision: 38602084
total keys: 1182
total size: 19 MB
~~~

snapshot 本身也做了 SHA256 校验。

如果需要看更完整的 etcd 备份与恢复验证过程，可以继续看站内的 [Kubernetes 上的 etcd 备份与恢复：三成员恢复测试](/zh/blog/etcd-backup-and-restore-on-kubernetes/)。

这里还碰到一个小兼容问题：当时使用的 etcd 镜像里没有 <code>etcdutl</code>，所以 snapshot 状态最后使用的是旧命令：

~~~bash
etcdctl snapshot status
~~~

命令会提示 deprecated，但 snapshot 本身是正常的。

同时我也打包了 <code>/etc/kubernetes</code>。这个压缩包里包含 PKI 私钥，包括 CA key，因此它只能当恢复文件保存，绝对不应该上传到公开文章、GitHub 或附件里。

### 先只升级 kubeadm，并验证 checksum

因为当前集群使用的是手工二进制，所以目标 kubeadm 也是直接下载后校验。

实际 checksum 验证记录是：

~~~text
kubeadm-v1.27.16: OK
33622018f83515331ac70c2041eba5d814a6d78a40b8869f089ea502f63a1421  kubeadm-v1.27.16
~~~

替换完成后：

~~~text
/usr/local/bin/kubeadm
v1.27.16
~~~

旧 kubeadm 并没有直接丢掉，而是提前放进恢复点里。

### 在真正 apply 之前先做 upgrade plan

目标版本 kubeadm 就位后，我先执行 upgrade plan。

这是第一阶段里最重要的一段输出之一：

~~~text
COMPONENT                 CURRENT   TARGET
kube-apiserver            v1.27.0   v1.27.16
kube-controller-manager   v1.27.0   v1.27.16
kube-scheduler            v1.27.0   v1.27.16
kube-proxy                v1.27.0   v1.27.16
CoreDNS                   v1.10.1   v1.10.1
etcd                      3.5.7-0   3.5.12-0
~~~

同时 kubeadm 明确告诉我们，还有哪些部分需要后续手工升级：

~~~text
COMPONENT   CURRENT       TARGET
kubelet     5 x v1.27.0   v1.27.16
~~~

组件配置检查结果：

~~~text
API GROUP                 CURRENT VERSION   PREFERRED VERSION   MANUAL UPGRADE REQUIRED
kubeproxy.config.k8s.io   v1alpha1          v1alpha1            no
kubelet.config.k8s.io     v1beta1           v1beta1             no
~~~

plan exit code 为 0。

在真正执行之前，我还做了一次 dry run：

~~~bash
kubeadm upgrade apply v1.27.16 --dry-run
~~~

dry run 成功。

对于后面这种多跳升级，我准备每一跳都保留：

~~~text
upgrade plan
dry run
~~~

因为这样最终文章里可以清楚区分：

> kubeadm 计划做什么

和：

> 实际升级时发生了什么

### 真正执行 control-plane 升级

control-plane 的实际命令是：

~~~bash
kubeadm upgrade apply v1.27.16 --yes
~~~

执行成功。

这一步里 kubeadm 升级了 static Pod 形式的 control plane，同时也升级了 etcd，并自动续签了部分控制平面证书。

关键组件变化：

~~~text
kube-apiserver             v1.27.0  → v1.27.16
kube-controller-manager    v1.27.0  → v1.27.16
kube-scheduler             v1.27.0  → v1.27.16
kube-proxy                 v1.27.0  → v1.27.16
etcd                       3.5.7-0  → 3.5.12-0
CoreDNS                    v1.10.1  → v1.10.1
~~~

kubeadm 同时把旧 static Pod manifest 备份到了 <code>/etc/kubernetes/tmp/</code>。

#### 证书剩余时间也发生了变化

升级前，非 CA Kubernetes 证书大约只剩 102 天。

执行 <code>kubeadm upgrade apply</code> 后，剩余时间变成大约 364 天。

这并不是我手工执行了 renew，而是 kubeadm upgrade 过程的一部分。

所以以后遇到 control-plane 升级，我会同时记录升级前后的证书状态，而不是简单认为“patch 升级只改二进制”。

### 为什么 control plane 已经升级，kubectl get nodes 还是 v1.27.0？

这是一个很容易误判的地方。

control-plane 组件已经变成 <code>v1.27.16</code> 后：

~~~bash
kubectl get nodes
~~~

仍然显示各节点：

~~~text
v1.27.0
~~~

这是正常的。

<code>kubectl get nodes</code> 的 <code>VERSION</code> 列显示的是 **kubelet version**，不是 kube-apiserver version。

此时实际状态大致是：

~~~text
control-plane static Pods: v1.27.16
etcd:                      3.5.12
kubelets:                  v1.27.0
~~~

因此不能只看 Node 的 VERSION 列就判断 control-plane upgrade 是否失败。

### 等 kube-proxy 完成滚动更新

control-plane apply 刚完成时，kube-proxy 处于真实的 rollout 中间态：部分 Pod 已经是 <code>v1.27.16</code>，部分还在 <code>v1.27.0</code>。

我没有把这个中间态当作故障，而是显式等待：

~~~bash
kubectl -n kube-system rollout status ds/kube-proxy --timeout=180s
~~~

确认所有 kube-proxy 都完成 rollout 后，才继续升级 kubelet。

这也是为什么保留真实日志很重要：只看某一个时间点的截图，很容易把正常滚动过程误认为异常。

### 升级 control-plane kubelet 和 kubectl

目标 kubelet 和 kubectl 同样先下载并做 checksum 验证。

然后 drain control-plane：

~~~bash
kubectl drain master --ignore-daemonsets
~~~

这一步成功。

替换 <code>/usr/local/bin/kubelet</code> 和 <code>/usr/local/bin/kubectl</code> 后：

~~~bash
systemctl daemon-reload
systemctl restart kubelet
~~~

节点回来后：

~~~text
master   Ready,SchedulingDisabled   ...   v1.27.16
~~~

API readiness 仍然通过，于是：

~~~bash
kubectl uncordon master
~~~

此时 control plane 已经完整到 <code>v1.27.16</code>，但 4 个 worker 仍然是 <code>v1.27.0</code>。

### worker 一台一台升级

每个 worker 使用同样的高层流程：

~~~text
复制已验证的二进制
↓
备份旧 binary 和 kubelet config
↓
替换 kubeadm / kubectl
↓
kubeadm upgrade node
↓
drain
↓
替换 kubelet
↓
restart kubelet
↓
确认 Ready,SchedulingDisabled + 目标版本
↓
uncordon
↓
再次验证
~~~

在每个 worker 上先执行：

~~~bash
kubeadm upgrade node
~~~

用于更新该节点自己的 kubelet configuration。

真正有价值的部分从这里开始，因为 node1 的 drain 并没有一次成功。

### Drain 失败 #1：emptyDir 阻止驱逐

node1 第一次 drain：

~~~text
cannot delete Pods with local storage
(use --delete-emptydir-data to override):
  kube-system/metrics-server-...
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...

drain exit code: 1
~~~

此时 node1 已经 cordon，但 drain 没完成。

我没有直接加一堆强制参数，而是先确认这些 Pod 都有 controller 管理，并检查这些本地数据是否只是当前测试集群里可丢弃的 <code>emptyDir</code>。

确认以后，第二次 drain 才显式使用：

~~~bash
kubectl drain node1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=5m
~~~

然后又碰到了第二个 blocker。

### Drain 失败 #2：PodDisruptionBudget 不允许任何 disruption

<code>prometheus-adapter</code> 当时只有 1 个副本，而 PDB 是：

~~~text
MIN AVAILABLE          1
CURRENT                1
DESIRED                1
ALLOWED DISRUPTIONS    0
~~~

这意味着唯一健康副本不能被 voluntary eviction。

我没有绕过 Eviction API，而是临时把 Deployment 扩到 2 个副本，并等待两个都 Ready。这样 PDB 才允许 1 个 disruption，drain 才能继续。

node1 升级完成并 uncordon 后，再把 <code>prometheus-adapter</code> 恢复到原来的 1 个副本。

这里真正值得记住的不是“遇到 PDB 就扩容”。

更准确的经验是：

> 先看 PDB，再看 workload 类型和副本拓扑，然后决定怎样制造一个安全的可中断窗口。

换成别的应用，直接扩副本未必是正确做法。

### 同一个 blocker 后面又跟着 workload 跑到了 node3 和 node4

逐节点升级并不是彼此完全独立的。

一个 Pod 从 node1 被驱逐后，controller 会在其他节点创建 replacement。这样某些单副本 workload 会被调度到“还没升级”的节点。

结果就是，后面 drain node3、node4 时，又碰到了同类 <code>emptyDir</code> blocker。

这次真实过程带来的经验是：

> 顺序维护多个 worker 时，要持续观察 singleton / stateful workload 被重新调度到了哪里。blocker 可能跟着 workload 一起移动。

如果 replacement Pod 在驱逐后无法重新调度，可以继续参考站内的 [Kubernetes Pod Pending：从调度失败开始排查](/zh/blog/kubernetes-pod-pending/)。

确认相关普通 Pod 已经迁走、节点上只剩 Calico、kube-proxy、node-exporter 这类 DaemonSet 后，再继续 kubelet upgrade。

### node2 暴露了一个比升级本身更严重的 Prometheus 存储问题

我把 node2 留到最后，因为它上面运行着：

~~~text
prometheus-k8s-0
~~~

Prometheus 的 PDB：

~~~text
MIN AVAILABLE          1
ALLOWED DISRUPTIONS    0
~~~

StatefulSet 只有 1 个副本。

在调整 PDB 之前，我先检查了它的存储。

结果比升级本身更值得关注：

~~~text
monitoring namespace 没有 PVC
集群没有 StorageClass
没有 PV
~~~

Prometheus Pod 的真实 volume：

~~~text
prometheus-k8s-db => emptyDir={}
~~~

也就是说，这个 Prometheus 虽然已经跑了很多个月，但 TSDB 根本没有落到 persistent storage。

容器 restart 本身不等于删除 Pod，所以不会因为普通 container restart 自动丢掉已有 emptyDir；但 Pod 一旦被删除或驱逐，emptyDir 就没了。

因此 drain node2 会导致当前 Prometheus 历史数据丢失。

这是测试集群，所以这次明确接受了这个数据损失风险；如果是生产环境，我会在这里直接停止升级，先修 Prometheus persistence。

为了让 voluntary eviction 能继续，我先保存原始 PDB YAML，然后临时把：

~~~text
minAvailable: 1
~~~

改成：

~~~text
minAvailable: 0
~~~

确认允许 1 个 disruption 后，才使用 <code>--delete-emptydir-data</code> drain node2。

升级 kubelet、uncordon 以后，等待 Prometheus 新 Pod Ready，再恢复原来的 PDB。

这次维护实际上顺便完成了一次“存储设计审计”：Prometheus 的 persistence 问题不是升级造成的，但升级过程把它暴露出来了。

### 最终 v1.27.16 验证

所有 worker 完成后，5 个节点全部统一到：

~~~text
NAME     STATUS   ROLES           VERSION
master   Ready    control-plane   v1.27.16
node1    Ready    worker          v1.27.16
node2    Ready    worker          v1.27.16
node3    Ready    worker          v1.27.16
node4    Ready    worker          v1.27.16
~~~

客户端和服务端版本也一致：

~~~text
kubeadm:            v1.27.16
kubelet:            v1.27.16
kubectl client:     v1.27.16
Kubernetes server:  v1.27.16
~~~

最终 kube-system 检查里所有 system Pod 都是 Running。

API verbose readiness 也通过，包括 etcd：

~~~text
[+]ping ok
[+]etcd ok
[+]etcd-readiness ok
...
readyz check passed
~~~

<code>kubectl top nodes</code> 能正常返回 5 个节点的 metrics。

最终检查点里，Prometheus 已经作为新 Pod 重建并恢复到 <code>2/2 Running</code>，PDB 也恢复回 <code>minAvailable: 1</code>。

## Checkpoint 1 的关键结论

| 项目 | 升级前 | 升级后 |
| --- | --- | --- |
| Kubernetes control plane | v1.27.0 | v1.27.16 |
| 5 个节点 kubelet | v1.27.0 | v1.27.16 |
| kube-proxy | v1.27.0 | v1.27.16 |
| etcd | 3.5.7-0 | 3.5.12-0 |
| CoreDNS | v1.10.1 | v1.10.1 |
| 非 CA 证书剩余时间 | 约 102 天 | 约 364 天 |
| Node 状态 | 全部 Ready | 全部 Ready |
| API readiness | 通过 | 通过 |

同时暴露出 3 个实际运维风险：

1. 使用 <code>emptyDir</code> 的 workload 会阻止 <code>kubectl drain</code>。
2. 单副本 + <code>minAvailable: 1</code> 的 PDB 会让 voluntary eviction 无法进行。
3. 看起来像“有状态服务”的 workload 也可能根本没有 persistent storage，drain 前必须检查真实 volume source。

## FAQ

### kubeadm 可以跳过 Kubernetes minor version 吗？

不可以。kubeadm 官方升级流程明确不支持跳过 minor version，所以这次迁移按 minor version 一步一步向前推进。

### 从 v1.27.0 到 v1.28 之前，必须先升级到 v1.27.16 吗？

不是硬性要求。真正不能跳过的是 1.28 这个 minor version。我选择先到 <code>v1.27.16</code>，是因为它是 1.27 系列最终 patch，可以先建立一个更干净、更可控的 checkpoint，再跨进 1.28。

### kubeadm upgrade apply 会顺便升级 kubelet 吗？

不会。这次真实过程里，<code>kubeadm upgrade apply</code> 已经把 control-plane static Pod 和 etcd 升级到目标版本，但各 Node 的 <code>VERSION</code> 仍然显示 <code>v1.27.0</code>。只有后面逐台替换 kubelet 后，Node 版本才变成 <code>v1.27.16</code>。

### 为什么 kubectl drain 会失败？

这次碰到了两类独立 blocker。一类是 Pod 使用 <code>emptyDir</code>，kubectl 不会默认替你决定丢弃本地临时数据；另一类是单副本 workload 被 PDB 保护，并且 <code>minAvailable: 1</code>，导致允许的 voluntary disruption 数量为 0。

### drain 节点会删除 emptyDir 数据吗？

可能会。默认情况下，kubectl drain 会因为 Pod 使用 <code>emptyDir</code> 而拒绝继续；只有显式确认 <code>--delete-emptydir-data</code> 后才会驱逐这些 Pod。Pod 被删除并在其他节点重建后，旧 Pod 的 <code>emptyDir</code> 内容不会跟过去。

## 下一阶段：v1.27.16 → v1.28.15

现在整个集群已经统一到：

~~~text
v1.27.16
~~~

下一跳是：

~~~text
v1.27.16
  ↓
v1.28.15
~~~

开始下一跳之前，我会先创建新的恢复点，并单独检查 Kubernetes 1.28 的版本特定变化，而不是假设后面的行为和 1.27 完全一致。

这篇文章后面会继续基于真实升级日志追加，而不是事后重新构造一条“全程无错误”的 happy path。

## 参考资料

- <a href="https://kubernetes.io/zh-cn/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes：补丁版本</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Kubernetes：升级 kubeadm 集群</a>
- <a href="https://kubernetes.io/zh-cn/docs/tasks/administer-cluster/kubeadm/upgrading-linux-nodes/" target="_blank" rel="noopener noreferrer">Kubernetes：升级 Linux 节点</a>
- <a href="https://kubernetes.io/releases/version-skew-policy/" target="_blank" rel="noopener noreferrer">Kubernetes Version Skew Policy</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain reference</a>
- <a href="https://kubernetes.io/docs/concepts/workloads/pods/disruptions/" target="_blank" rel="noopener noreferrer">Pod disruption budgets and voluntary disruptions</a>
