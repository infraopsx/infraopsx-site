---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes Pod 一直 Pending：一套实用的排查流程"
description: "从调度事件、资源请求、Affinity、Taint 和存储几个方向系统定位 Kubernetes Pending Pod。"
pubDate: 2026-09-18
category: Kubernetes
locale: zh-CN
tags:
  - Kubernetes
  - 故障排查
  - Linux
enPath: /blog/kubernetes-pod-pending/
zhPath: /zh/blog/kubernetes-pod-pending/
---

Kubernetes Pod 处于 `Pending` 状态时，真正需要解决的问题并不是：

**“Kubernetes 为什么坏了？”**

而是：

**“Pod 当前卡在哪一个阶段？”**

不停删除 Pod、重启 Deployment 或者盲目增加副本，通常并不能解决问题。

更有效的方式，是直接从 Kubernetes Scheduler 给出的信息开始分析。

下面是一套我在实际环境中比较常用的排查流程。

---

## 1. 第一件事：看 Events，不要先猜

首先执行：

```bash
kubectl get pod -n <namespace> <pod-name> -o wide
kubectl describe pod -n <namespace> <pod-name>
```

重点看 `kubectl describe` 最下面的 **Events**。

例如可能看到：

```text
0/6 nodes are available:
2 node(s) didn't match pod affinity rules,
4 Insufficient cpu.

preemption:
0/6 nodes are available:
2 Preemption is not helpful for scheduling,
4 No preemption victims found for incoming pod.
```

实际上这几行已经提供了非常重要的信息：

- 2 个节点因为 Affinity 规则不匹配被排除
- 另外 4 个节点因为 CPU Request 无法满足而被排除
- Scheduler 尝试判断抢占是否能够解决
- 结果也找不到合适的低优先级 Pod 可以释放资源

也就是说：

**问题已经从“Pod Pending”缩小成了“调度约束无法满足”。**

---

## 2. 先判断 Pod 到底有没有被调度

并不是所有 `Pending` 都意味着 Scheduler 没找到节点。

执行：

```bash
kubectl get pod -n <namespace> <pod-name> \
  -o jsonpath='{.spec.nodeName}{"\n"}'
```

如果没有任何输出，说明 Pod 还没有被分配到节点。

这时重点检查：

- CPU / Memory Request
- nodeSelector
- Affinity / Anti-Affinity
- Taint / Toleration
- Topology Spread
- PVC
- Storage topology

如果这里已经有 Node Name，说明 Scheduler 已经完成工作。

这时 Pending 很可能发生在后面的阶段，例如：

- Volume 挂载
- Image Pull
- Container Creating
- CNI 网络初始化

先把这两种 Pending 区分开，可以节省大量时间。

---

## 3. 检查 CPU 和内存 Request

Kubernetes 调度时看的不是当前容器到底用了多少 CPU，而是：

**Pod 声明了多少 Resource Request。**

查看：

```bash
kubectl describe pod -n <namespace> <pod-name>
```

重点找：

```text
Requests:
  cpu:
  memory:
```

也可以直接查看 Deployment：

```bash
kubectl get deployment -n <namespace> <deployment-name> -o yaml
```

然后检查节点：

```bash
kubectl describe node <node-name>
```

重点关注：

```text
Allocatable
Allocated resources
```

有时候你看：

```bash
kubectl top nodes
```

发现 CPU 才用了 30%。

但 Scheduler 仍然告诉你：

```text
Insufficient cpu
```

这并不矛盾。

因为：

> **实时使用量 ≠ Scheduler 已经预留的 Request。**

建议同时查看：

```bash
kubectl top nodes
kubectl top pods -A
```

但是调度问题一定要结合 Request 一起判断。

---

## 4. 检查 nodeSelector 和 Affinity

如果 Events 中出现：

```text
didn't match pod affinity rules
```

就应该直接查看 Pod 定义：

```bash
kubectl get pod -n <namespace> <pod-name> -o yaml
```

重点寻找：

```yaml
nodeSelector:
```

以及：

```yaml
affinity:
```

其中包括：

```yaml
nodeAffinity:
podAffinity:
podAntiAffinity:
```

生产环境中经常出现这样的组合：

- Pod 必须部署到带某个 Label 的节点
- 同时要求靠近某个工作负载
- 又要求与另外一个工作负载分散
- 真正满足条件的节点又没有足够 CPU

每一条规则单独看都可能是合理的。

但组合以后：

**可用节点数量可能直接变成 0。**

查看 Node Label：

```bash
kubectl get nodes --show-labels
```

或者：

```bash
kubectl get nodes \
  -L kubernetes.io/hostname \
  -L topology.kubernetes.io/zone
```

---

## 5. 检查 Taint 和 Toleration

有些 Node 明明资源足够，但是 Pod 仍然无法调度。

这时需要检查 Taint：

```bash
kubectl describe node <node-name> | grep -A3 Taints
```

或者：

```bash
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
TAINTS:.spec.taints
```

然后检查 Pod：

```bash
kubectl get pod -n <namespace> <pod-name> \
  -o jsonpath='{.spec.tolerations}'
```

常见情况包括：

- Control Plane 节点
- GPU 专用节点
- 特定业务节点
- 临时故障节点
- 隔离节点

这里不要看到 Taint 就直接：

> “加个 Toleration 不就行了？”

应该先确认：

**这个 Pod 原本是否就应该允许运行在这个节点上。**

---

## 6. 检查 PVC 和 StorageClass

有时候真正阻止 Pod 调度的是存储。

先看：

```bash
kubectl get pvc -n <namespace>
```

然后：

```bash
kubectl describe pvc -n <namespace> <pvc-name>
```

检查：

- StorageClass
- AccessMode
- 容量
- Provisioner
- Binding 状态
- Provisioning Error

再检查：

```bash
kubectl get storageclass
kubectl describe storageclass <storage-class>
```

特别留意：

```text
volumeBindingMode
```

如果使用：

```text
WaitForFirstConsumer
```

Storage Provisioning 和 Pod Scheduling 就可能产生关联。

因此表面上看起来是 Scheduler 问题，实际上背后可能存在：

**存储拓扑约束。**

---

## 7. Scheduler 的错误信息应该逐字理解

例如：

```text
0/6 nodes are available:
2 node(s) didn't match pod affinity rules,
4 Insufficient cpu.
```

不要把它简单理解成：

> Kubernetes 调度失败。

应该转换成：

| 约束 | 被排除节点 |
|---|---:|
| Affinity 不匹配 | 2 |
| CPU Request 无法满足 | 4 |
| 最终可用节点 | 0 |

这样问题马上就小了很多。

后续可能的解决方式包括：

- 修正过于严格的 Affinity
- 调整不合理的 CPU Request
- 调整其他 Workload
- 扩容节点
- 调整 Node Label
- 增加真正符合要求的节点

但是应该选择哪一种，取决于原始架构设计。

---

## 8. Preemption 信息代表什么

Events 里可能还有：

```text
Preemption is not helpful for scheduling
```

或者：

```text
No preemption victims found for incoming pod
```

这并不代表 Kubernetes 的 Preemption 坏了。

它表示 Scheduler 已经分析：

> 如果赶走一些低优先级 Pod，能不能把当前 Pod 放进去？

结果发现不能。

例如下面的问题，即使赶走其他 Pod 也没有意义：

- Affinity 不匹配
- NodeSelector 不匹配
- 缺少 Toleration
- Storage topology 冲突

所以 Scheduler 才会告诉你：

```text
Preemption is not helpful
```

---

## 一套简单的排查决策树

```text
Pod Pending
    |
    +-- nodeName 是否为空？
    |       |
    |       +-- 是
    |       |    |
    |       |    +-- 查看 Scheduler Events
    |       |    +-- 检查 Resource Request
    |       |    +-- 检查 nodeSelector / Affinity
    |       |    +-- 检查 Taint / Toleration
    |       |    +-- 检查 PVC / Storage topology
    |       |
    |       +-- 否
    |            |
    |            +-- 检查 Volume
    |            +-- 检查 Image Pull
    |            +-- 检查 CNI
    |            +-- 检查 Container Creating
    |
    +-- 每次修改后重新验证
```

---

## 常见错误做法

### 不停删除 Pod

如果 Deployment 创建出来的还是同样的 Pod Spec，那么重新创建以后依旧会遇到同样的问题。

### 只看 CPU 实时利用率

Scheduler 看的是 Resource Request 和 Allocatable。

### 看到 Affinity 就直接删除

Affinity 可能承担着高可用、故障域隔离或者业务隔离的作用。

### 遇到 Taint 就全部加 Toleration

这样可能让 Pod 被调度到原本明确不应该运行的节点。

### 把所有 Pending 当成一个问题

`Pending` 只是状态。

**不是根因。**

---

## 最后总结

对于一个还没有被分配 Node 的 Pending Pod，我通常第一步都是：

```bash
kubectl describe pod <pod>
```

然后认真阅读 Scheduler Events。

很多 Kubernetes 调度问题，只要把 Scheduler 给出的文字转换成具体约束，就会从一个看起来很复杂的问题变成几个可以逐一验证的小问题。

**先定位，再修改。**
