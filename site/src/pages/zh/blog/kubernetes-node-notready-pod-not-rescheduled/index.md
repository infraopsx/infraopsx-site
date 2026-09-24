---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes Node NotReady 后，Pod 为什么还不去其他节点？"
description: "一次实际的 Kubernetes 排障记录：Node 已经 NotReady，但业务 Pod 没有像预期那样在其他节点恢复运行。记录 NoSchedule、NoExecute、tolerationSeconds、nodeName 和 DaemonSet 等几个容易忽略的排查点。"
pubDate: "2026-09-24"
category: Kubernetes
tags:
  - Kubernetes
  - Scheduling
  - Taints
  - Tolerations
  - Node
  - NotReady
  - Troubleshooting
enPath: "/blog/kubernetes-node-notready-pod-not-rescheduled/"
zhPath: "/zh/blog/kubernetes-node-notready-pod-not-rescheduled/"
---

最近碰到一个挺容易误判的问题。

承载 Pod 的 Node 已经出故障了，`kubectl get nodes` 里也能看到节点状态异常，但业务 Pod 并没有像预想中那样在其他正常 Node 上恢复运行。

第一反应一般是：

> Scheduler 是不是没工作？

但继续往下查后发现，这类问题不一定和 Scheduler 本身有关。`NoSchedule`、`NoExecute`、`tolerationSeconds`、`nodeName`，甚至 Pod 是不是由 Deployment 管理，都会影响最后看到的现象。

Kubernetes 官方关于 <a href="https://kubernetes.io/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration/" target="_blank" rel="noopener noreferrer">污点和容忍度</a> 的说明其实已经很详细了，不过有几个点在实际排障时特别容易忽略，所以单独记一下。

## 先别急着说“Pod 迁移”

我们平时习惯说：

> Node 挂了，Pod 会自动迁移到其他节点。

严格来说，这个说法并不准确。

Kubernetes 不会把一个正在运行的 Pod 从 `node-a` 搬到 `node-b`。更常见的过程是：

```text
Node 异常
↓
原来的 Pod 被驱逐或删除
↓
Deployment / StatefulSet 等 Controller 发现副本数不够
↓
创建一个新的 Pod
↓
Scheduler 再给这个新 Pod 找其他可用 Node
```

所以排查“Pod 为什么没迁移”时，最好先拆成两个问题：

```text
旧 Pod 为什么还没被处理？

新的 Pod 为什么没有被重新创建或调度？
```

这两个问题其实不是一回事。

如果原来只是一个裸 Pod：

```yaml
apiVersion: v1
kind: Pod
```

那即使这个 Pod 最后没了，也不会有人自动再给你创建一个。

所以第一件事，我一般会先看：

```bash
kubectl get pod <pod-name> -o yaml
```

看看 `metadata.ownerReferences`，确认它到底是 Deployment、StatefulSet、DaemonSet，还是一个裸 Pod。

## NoSchedule 没有很多人想象得那么“强”

先看 `NoSchedule`。

例如某个 Node 有：

```text
INFRA=true:NoSchedule
```

查看：

```bash
kubectl describe node node2-192-168-240-101 | grep Taint -A2
```

输出：

```text
Taints:             INFRA=true:NoSchedule
Unschedulable:      false
Lease:
```

正常情况下，一个没有对应 toleration 的 Pod，Scheduler 不会把它调度到这个节点。

这很好理解。

但如果 Pod 里直接写了：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-nodename
spec:
  containers:
  - image: nginx
    imagePullPolicy: IfNotPresent
    name: backup
  nodeName: node2-192-168-240-101
```

事情就不一样了。

这个 Pod 没有针对 `INFRA=true:NoSchedule` 配 toleration，但它仍然可以跑到这个节点：

```bash
kubectl get pods test-nodename -o wide
```

```text
NAME            READY   STATUS    RESTARTS   AGE   IP              NODE
test-nodename   1/1     Running   0          64m   10.233.108.30   node2-192-168-240-101
```

原因就是：

```yaml
nodeName: node2-192-168-240-101
```

手动指定 `.spec.nodeName` 会绕过正常的 Scheduler 选点过程。Kubernetes 官方文档也明确说明，即使目标 Node 有 Pod 并不容忍的 `NoSchedule` Taint，直接指定 `nodeName` 仍然可以把 Pod 绑定过去。

所以 `NoSchedule` 更准确的理解应该是：

> 不让 Scheduler 再把不匹配 toleration 的 Pod 调度进来。

它并不是：

> 这台 Node 上绝对不能存在 Pod。

这也是为什么生产环境里一般不太建议直接写死 `nodeName`。写死以后，很多本来应该交给 Scheduler 做的选择就没有了。

## 真正和“已经跑着的 Pod”关系更大的，是 NoExecute

`NoExecute` 和 `NoSchedule` 不一样。

它除了影响新的 Pod，还会影响已经运行在节点上的 Pod。

例如 Node 上出现：

```text
INFRA=true:NoExecute
```

如果 Pod 没有匹配的 toleration，它就不能继续容忍这个 Taint。

如果 Pod 写了：

```yaml
tolerations:
- key: "INFRA"
  operator: "Equal"
  value: "true"
  effect: "NoExecute"
  tolerationSeconds: 60
```

意思很直接：

> 这个 Pod 可以先忍 60 秒，60 秒之后就不再容忍。

实际线上这种配置挺有用，因为短暂抖动没必要马上把 Pod 全部赶走。

但真正容易踩坑的是下面这种：

```yaml
tolerations:
- key: "INFRA"
  operator: "Equal"
  value: "true"
  effect: "NoExecute"
```

注意，这里没有：

```yaml
tolerationSeconds:
```

这个时候不是“默认等一段时间”，而是：

> 对这个匹配的 `NoExecute` Taint 一直容忍下去。

Kubernetes API 对 `tolerationSeconds` 的定义也是这个意思：对于匹配的 `NoExecute` Taint，如果没有设置这个字段，就表示永久容忍。

这个细节很容易被忽略。

## Node 出故障后，这两个 Taint 是从哪里来的？

前面举的：

```text
INFRA=true:NoExecute
```

是我们自己手动设置的 Taint。

但 Node 真正发生故障时，Kubernetes 还会根据 Node Condition 自动维护一些系统内置的 Taint。

Kubernetes 官方在 <a href="https://kubernetes.io/zh-cn/docs/reference/labels-annotations-taints/" target="_blank" rel="noopener noreferrer">常用的标签、注解和污点</a> 里专门列出了这些系统值，其中就包括：

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
```

它们和 Node 的 `Ready` Condition 有直接关系。

可以简单理解成：

```text
Ready=False
→ node.kubernetes.io/not-ready
```

以及：

```text
Ready=Unknown
→ node.kubernetes.io/unreachable
```

所以平时执行：

```bash
kubectl get nodes
```

虽然看到的可能只是：

```text
NotReady
```

但继续排查时，最好再看看真正的 `Ready` Condition 和 Node 上的 Taint。

可以执行：

```bash
kubectl describe node <node-name>
```

或者：

```bash
kubectl get node <node-name> -o yaml
```

在 Node 对象里可能看到：

```yaml
status:
  conditions:
  - type: Ready
    status: "False"
```

也可能是：

```yaml
status:
  conditions:
  - type: Ready
    status: "Unknown"
```

这两个状态背后的含义不完全一样，也解释了为什么 Node 上会出现不同的故障 Taint。

所以这里我一般会同时看：

```text
Conditions
Taints
```

而不是只看到 `kubectl get nodes` 里的 `NotReady` 就停下来。

## Node 宕机时，要看 Pod 是否容忍了这些故障 Taint

到这里，前面的 `NoExecute` 就能接上了。

不能看到某个 Pod 有：

```yaml
effect: NoExecute
```

而且没写 `tolerationSeconds`，就直接下结论：

> 难怪节点挂了 Pod 不迁移。

还得看它到底容忍的是哪个 Taint。

Node 出现 `NotReady` 或失联时，真正应该重点关注的通常是：

```text
node.kubernetes.io/not-ready:NoExecute
```

和：

```text
node.kubernetes.io/unreachable:NoExecute
```

所以我在排查这种问题时，更关注 Pod 里有没有类似：

```yaml
tolerations:
- key: "node.kubernetes.io/not-ready"
  operator: "Exists"
  effect: "NoExecute"
```

或者：

```yaml
tolerations:
- key: "node.kubernetes.io/unreachable"
  operator: "Exists"
  effect: "NoExecute"
```

如果这种 toleration 没有配置：

```yaml
tolerationSeconds:
```

那就值得重点看了。

因为它表示这个 Pod 可以一直容忍对应的 Node 故障 Taint。

这和下面这种自定义容忍完全不是一回事：

```text
INFRA=true:NoExecute
```

`INFRA` 并不会自动匹配 `node.kubernetes.io/not-ready` 或 `node.kubernetes.io/unreachable`，key 还是得对得上。

## 普通 Pod 默认其实会等 5 分钟

Kubernetes 默认不会因为 Node 短暂抖一下就马上把 Pod 全赶走。

官方在 <a href="https://kubernetes.io/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-based-evictions" target="_blank" rel="noopener noreferrer">污点和容忍度：基于污点的驱逐</a> 这一节里明确说明，普通 Pod 通常会自动得到针对下面两个 Taint 的 toleration：

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
```

并且默认：

```text
tolerationSeconds: 300
```

也就是常见的 5 分钟。

如果用户或者某个 Controller 已经显式设置了对应 toleration，Kubernetes 不会再按这个默认值补一份。

所以 Node 刚刚进入 `NotReady` 时，Pod 还留在原节点上，并不一定是异常。

这反而是合理设计。

否则一台 Node 网络闪断几秒，整台机器上的业务立刻全部重新调度一遍，问题可能更大。

排查时最直接的办法还是：

```bash
kubectl get pod <pod-name> -o yaml
```

重点看：

```yaml
tolerations:
```

特别是这些字段：

```text
key
operator
effect
tolerationSeconds
```

不要只看“有没有 toleration”，要看它到底容忍什么、容忍多久。

## nodeName 还有另一个坑：新的 Pod 也可能继续被钉回原节点

假设不是裸 Pod，而是 Deployment。

如果 Deployment 的 Pod Template 里写了：

```yaml
spec:
  template:
    spec:
      nodeName: node2-192-168-240-101
```

那么即使旧 Pod 最后被删除，Deployment 重新创建了一个新的 Pod，这个新 Pod 还是会带着：

```yaml
nodeName: node2-192-168-240-101
```

于是你看到的现象就可能变成：

> Node 都挂了，为什么 Pod 还是不去其他节点？

这时其实不是 Kubernetes 不想调度，而是根本没有给 Scheduler 选择的机会。

你已经把 Node 写死了。

如果只是想限制 Pod 去某一类节点，通常更适合考虑：

```yaml
nodeSelector:
```

或者：

```yaml
affinity:
```

而不是直接绑具体 Node 名称。

## 还有一种情况：它本来就是 DaemonSet

如果 Pod 一直挂在异常 Node 上，也别忘了看一下：

```bash
kubectl get pod <pod-name> -o yaml
```

如果 `ownerReferences` 里是：

```yaml
kind: DaemonSet
```

那排查思路就要换一下。

DaemonSet Pod 默认会带上针对：

```text
node.kubernetes.io/unreachable
node.kubernetes.io/not-ready
```

的 `NoExecute` toleration，并且没有 `tolerationSeconds`。

这是 Kubernetes 的设计：DaemonSet Pod 不会仅仅因为这两种 Node 故障 Taint 就被驱逐。

所以看到 DaemonSet Pod 还绑定在原 Node 上，不要直接按普通 Deployment Pod 的“迁移”逻辑判断。

## 我现在碰到这种问题，一般按这个顺序查

先看 Node：

```bash
kubectl get nodes
```

再看具体节点：

```bash
kubectl describe node <node-name>
```

重点关注：

```text
Conditions
Taints
```

然后看 Pod：

```bash
kubectl get pod <pod-name> -o wide
```

再把完整 YAML 拉出来：

```bash
kubectl get pod <pod-name> -o yaml
```

通常重点看这些：

```text
.spec.nodeName
.spec.nodeSelector
.spec.affinity
.spec.tolerations
.metadata.ownerReferences
```

如果是 Node 故障场景，再专门找：

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
NoExecute
tolerationSeconds
```

如果旧 Pod 已经没了，但新的 Pod 还是没起来，那问题已经进入下一阶段。

这时就别再一直盯着 eviction 了，继续查：

```text
Scheduler
Taint / Toleration
NodeSelector / Affinity
CPU / Memory
PVC
Storage topology
```

到这里，问题一般已经变成一个正常的 Pending 排障。

如果最后走到这一步，可以继续看站内这篇：

[Kubernetes Pod Pending：从调度失败开始排查](/zh/blog/kubernetes-pod-pending/)

## 最后记几个容易混淆的点

`NoSchedule` 主要影响新的调度，不会把已经运行的 Pod 赶走。

`nodeName` 会绕过正常 Scheduler 选点，所以即使 Node 有 `NoSchedule`，Pod 仍然可能被直接绑定过去。

`NoExecute` 才会影响已经运行的 Pod。

对于匹配的 `NoExecute` Taint，如果 toleration 没有设置 `tolerationSeconds`，表示一直容忍。

Node 故障时，不要泛泛看所有 `NoExecute`，重点看：

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
```

最后，Pod 没有“迁移”过去，并不一定表示调度失败。

有时候真正的问题是：

> 旧 Pod 根本还没有被驱逐。

也有时候是：

> 旧 Pod 已经没了，但 Controller 没有创建新 Pod。

还有一种情况是：

> 新 Pod 已经创建了，只是因为资源、调度约束或者存储问题继续 Pending。

把这三种情况分开以后，这类问题其实就没那么绕了。

## 参考资料

- <a href="https://kubernetes.io/zh-cn/docs/concepts/scheduling-eviction/taint-and-toleration/" target="_blank" rel="noopener noreferrer">Kubernetes：污点和容忍度</a>
- <a href="https://kubernetes.io/zh-cn/docs/reference/labels-annotations-taints/" target="_blank" rel="noopener noreferrer">Kubernetes：常用的标签、注解和污点</a>
- <a href="https://kubernetes.io/zh-cn/docs/reference/kubernetes-api/definitions/toleration-v1/" target="_blank" rel="noopener noreferrer">Kubernetes API：Toleration</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_taint/" target="_blank" rel="noopener noreferrer">kubectl taint 参考</a>
