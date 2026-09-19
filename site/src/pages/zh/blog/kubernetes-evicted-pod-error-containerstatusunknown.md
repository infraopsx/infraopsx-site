---
layout: ../../../layouts/ArticleLayout.astro
title: "Kubernetes Pod 被 Evicted 后为什么仍显示 Error 或 ContainerStatusUnknown？"
description: "一次真实 Kubernetes 故障排查：Pod 因 ephemeral-storage 超限被驱逐后，为什么 kubectl get pods 仍可能显示 Error 或 ContainerStatusUnknown，以及如何确认根因、清理残留 Pod 并避免再次发生。"
pubDate: "2026-09-19"
tags:
  - Kubernetes
  - Troubleshooting
  - Storage
  - Containers
enPath: "/blog/kubernetes-evicted-pod-error-containerstatusunknown/"
zhPath: "/zh/blog/kubernetes-evicted-pod-error-containerstatusunknown/"
---

> 本文来自一次真实 Kubernetes 故障排查。示例中的 Namespace、Pod、Container、镜像仓库、IP、路径、ConfigMap、标签和业务名称均已匿名化，不影响问题本身的技术结论。

## 现象

集群中出现了已经失败但长期没有消失的 Pod：

```bash
kubectl -n prod-team-a get pod edge-proxy-7d9c7f8d8d-k2m4x
```

```text
NAME                            READY   STATUS   RESTARTS   AGE
edge-proxy-7d9c7f8d8d-k2m4x     0/2     Error    1          3d4h
```

另一个 Pod 则显示：

```bash
kubectl -n prod-team-b get pod platform-service-68df8c6d79-v7n2p
```

```text
NAME                               READY   STATUS                   RESTARTS   AGE
platform-service-68df8c6d79-v7n2p  0/2     ContainerStatusUnknown   2          2d8h
```

与此同时，Deployment / ReplicaSet 已经创建了新的 Pod，新的实例正常运行。

这就产生了几个问题：

1. 为什么旧 Pod 没有立即被删除？
2. 为什么 `kubectl get pods` 显示 `Error` 或 `ContainerStatusUnknown`，而不是 `Evicted`？
3. `Exit Code 137` 到底代表什么？
4. 真正的故障原因应该看哪里？

---

## 先说结论

这次故障真正重要的信息不是：

```text
Error
ContainerStatusUnknown
```

而是 Pod 级别状态：

```text
Status:   Failed
Reason:   Evicted
Message:  Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

也就是说：

```text
ephemeral-storage 超过限制
        ↓
kubelet 驱逐 Pod
        ↓
Pod Phase = Failed
Pod Reason = Evicted
```

而 `Error`、`ContainerStatusUnknown` 是容器终止后的状态信息，可能进一步影响 `kubectl get pods` 的 `STATUS` 展示。

因此排查这类问题时：

> **不要只看 `kubectl get pods` 的 STATUS 一列。**

---

## 1. `kubectl get pods` 的 STATUS 不等于 `.status.reason`

例如：

```bash
kubectl get pod -n prod-team-a edge-proxy-7d9c7f8d8d-k2m4x
```

显示：

```text
STATUS
Error
```

但是：

```bash
kubectl describe pod -n prod-team-a edge-proxy-7d9c7f8d8d-k2m4x
```

却可能看到：

```text
Status:   Failed
Reason:   Evicted
Message:  Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

这两者并不矛盾。

`kubectl get pods` 中的 `STATUS` 是面向人的展示结果，并不是 Kubernetes API 中独立保存的一个 Pod 状态字段。

`kubectl` 生成这一列时会综合 Pod 和容器状态，例如：

- Pod Phase
- Pod Reason
- Init Container 状态
- Container Waiting Reason
- Container Terminated Reason

所以一个 Pod 的 API 状态可能是：

```text
phase  = Failed
reason = Evicted
```

但最终展示为：

```text
Error
```

或者：

```text
ContainerStatusUnknown
```

### 更可靠的确认方式

直接查看 Pod API 字段：

```bash
kubectl get pod -n prod-team-a edge-proxy-7d9c7f8d8d-k2m4x \
  -o jsonpath='{.status.phase}{"\n"}{.status.reason}{"\n"}{.status.message}{"\n"}'
```

例如：

```text
Failed
Evicted
Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

对于根因判断，这比只看 `STATUS` 更可靠。

---

## 2. 为什么会出现 ContainerStatusUnknown？

故障现场某个 sidecar 的状态类似：

```text
State:       Terminated
Reason:      ContainerStatusUnknown
Message:     The container could not be located when the pod was terminated
Exit Code:   137
```

`ContainerStatusUnknown` 并不意味着：

```text
Kubernetes 不知道整个 Pod 在哪里
```

它更接近于：

> kubelet 在生成终止状态时，已经无法从 Container Runtime 获取到这个容器的有效状态。

比如容器已经被清理，或者运行时已经无法返回原来的容器信息，都可能留下这样的状态。

因此：

```text
ContainerStatusUnknown
```

通常是在描述**容器终止后的状态信息不完整**，不应该自动当作最初的故障根因。

本案例中，Pod 级别已经明确给出了：

```text
Reason: Evicted
```

所以应该继续追查 Eviction 的原因。

---

## 3. 真正的根因：ephemeral-storage 超限

`kubectl describe pod` 中最关键的一行是：

```text
Message: Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

资源配置类似：

```yaml
resources:
  requests:
    ephemeral-storage: 100Mi
  limits:
    ephemeral-storage: 2Gi
```

当 kubelet 管理本地临时存储时，如果 Pod / Container 的本地临时存储使用量超过配置的限制，Pod 可以被驱逐。

Kubernetes 统计的本地临时存储通常包括：

- 容器 writable layer
- Node 上的容器日志
- 非 `tmpfs` 的 `emptyDir`
- 其他由 kubelet 管理的本地临时数据

所以 `ephemeral-storage` 不能简单理解成 `/tmp` 的大小。

例如应用持续向 stdout / stderr 输出大量日志，也可能不断增加 Node 本地存储消耗。

---

## 4. Exit Code 137 不等于 OOM

现场还能看到：

```text
Exit Code: 137
```

137 可以理解为：

```text
128 + 9 = 137
```

其中信号 9 是：

```text
SIGKILL
```

所以可以确认：

> 容器最终遭到了强制终止。

但**仅凭 137 不能确定为什么被杀死**。

可能原因包括：

- OOM Kill
- kubelet 强制终止
- Pod Eviction 过程中的终止
- 超过 `terminationGracePeriodSeconds`
- 人工或运行时执行 force kill
- Node / Container Runtime 状态异常

因此不能简单写成：

```text
Exit 137 = OOM
```

也不能写成：

```text
Exit 137 = 一定是 SIGTERM 等待 30 秒后再 SIGKILL
```

本案例有更直接的证据：

```text
Reason:  Evicted
Message: Pod ephemeral local storage usage exceeds ...
```

所以根因应判断为：

> **Pod 因 ephemeral-storage 超过限制而被驱逐。**

---

## 5. 为什么新 Pod 已经起来，旧 Pod 还在？

这是 Kubernetes 的正常行为。

假设旧 Pod 由 Deployment 管理：

```text
Deployment
    ↓
ReplicaSet
    ↓
Old Pod → Failed / Evicted
```

ReplicaSet Controller 发现可用副本数不足后，可以创建新的 Pod：

```text
Old Pod → Failed
New Pod → Running
```

但是：

```text
创建替代 Pod
```

和：

```text
删除旧 Pod API 对象
```

是两件不同的事情。

Kubernetes 对失败 Pod 的 API 对象可以继续保留，直到：

- 用户显式删除
- Controller 删除
- PodGC 垃圾回收

因此出现下面的状态并不奇怪：

```text
edge-proxy-old     0/2   Error     ...
edge-proxy-new     2/2   Running   ...
```

业务已经恢复，不代表旧 Pod 对象必须立即消失。

---

## 6. PodGC 为什么没有马上清理？

`kube-controller-manager` 中有：

```text
--terminated-pod-gc-threshold
```

这个参数决定在终止 Pod 数量达到一定阈值后，Pod garbage collector 才开始清理。

Kubernetes 当前文档中的默认值是：

```text
12500
```

所以只有少量 Failed / Evicted Pod 时，它们可能长时间留在 API Server 中。

这就是为什么一个已经被驱逐几天的 Pod，仍可能出现在：

```bash
kubectl get pods
```

的输出里。

---

## 7. 推荐的排查顺序

以后看到：

```text
Error
ContainerStatusUnknown
Evicted
Unknown
```

不要先猜。

### 第一步：查看 Pod Phase / Reason / Message

```bash
kubectl get pod -n <namespace> <pod> \
  -o jsonpath='{.status.phase}{"\n"}{.status.reason}{"\n"}{.status.message}{"\n"}'
```

这是最重要的一步。

### 第二步：describe

```bash
kubectl describe pod -n <namespace> <pod>
```

重点关注：

```text
Status
Reason
Message
State
Last State
Exit Code
Limits
Requests
Events
```

### 第三步：看每个容器怎么结束的

```bash
kubectl get pod -n <namespace> <pod> \
  -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.state.terminated.reason}{"\t"}{.state.terminated.exitCode}{"\n"}{end}'
```

例如：

```text
network-helper      ContainerStatusUnknown   137
proxy-service       Error                    137
```

### 第四步：确认 Owner

```bash
kubectl get pod -n <namespace> <pod> \
  -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}{"/"}{.name}{"\n"}{end}'
```

例如：

```text
ReplicaSet/edge-proxy-7d9c7f8d8d
```

如果已经有健康的新副本，就可以把“业务是否恢复”和“旧 Pod 为什么还留着”分开看。

---

## 8. 如何快速找出 Failed Pod

单个 Namespace：

```bash
kubectl get pods -n <namespace> --field-selector=status.phase=Failed
```

所有 Namespace：

```bash
kubectl get pods -A --field-selector=status.phase=Failed
```

如果想直接看 Reason 和 Message：

```bash
kubectl get pods -A --field-selector=status.phase=Failed \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,REASON:.status.reason,MESSAGE:.status.message'
```

这种方式通常比：

```bash
kubectl get pods -A | grep -E 'Error|Unknown'
```

更接近 Kubernetes API 中真实保存的状态。

---

## 9. Failed / Evicted Pod 可以删除吗？

先确认：

1. Pod 已经是 `Failed`
2. 它属于 Deployment / ReplicaSet 等 Controller，或者已经确定不再需要
3. 如果业务需要持续运行，新副本已经健康

然后可以删除：

```bash
kubectl delete pod -n <namespace> <pod>
```

对于已经终止的 Pod，这主要是在删除 API Server 中留下的对象记录。

但这只是清理，不是根治。

如果 Pod 持续因为：

```text
ephemeral-storage
```

被驱逐，删除旧 Pod 只会让列表暂时变干净。

---

## 10. ephemeral-storage 应该怎么处理？

### 先找谁在写

重点确认：

```text
/tmp
/var/tmp
应用缓存目录
容器 writable layer
emptyDir
本地日志
```

### 检查日志增长

stdout / stderr 最终也会消耗 Node 本地存储。

可以关注：

- 单个 Pod 日志是否异常增长
- 是否存在日志循环
- Container Runtime 日志轮转是否合理
- Node 的 Pod 日志目录是否快速膨胀

### 不要只是把 2Gi 改大

例如直接：

```yaml
limits:
  ephemeral-storage: 20Gi
```

很可能只是把问题推迟。

更应该回答：

```text
谁在写？
写到哪里？
为什么持续增长？
这些数据是否应该持久化？
日志是否正确轮转？
```

### 需要长期保存的数据不要放在临时存储

根据场景考虑：

```text
PersistentVolume
对象存储
集中式日志系统
独立数据卷
```

---

## 11. Node 层面也要检查

本地存储问题还应检查 Node：

```bash
df -h
df -i
```

根据运行时和节点目录布局继续看：

```bash
du -xhd1 /var/log 2>/dev/null | sort -h
du -xhd1 /var/lib/containerd 2>/dev/null | sort -h
```

再检查：

```bash
kubectl describe node <node>
```

是否出现：

```text
DiskPressure
```

需要注意：

> Pod 自己超过 `ephemeral-storage` limit，与整个 Node 出现 `DiskPressure` 是相关但不同的两种情况。

本案例的直接证据是 Pod 自身临时存储超过配置限制。

---

## 12. 一个更可靠的判断模型

看到：

```text
Error
ContainerStatusUnknown
Exit Code 137
```

不要分别猜三个根因。

应该按层次看：

```text
kubectl get pods
        ↓
面向人的展示结果

Pod .status.phase / .status.reason / .status.message
        ↓
Failed / Evicted / ephemeral-storage exceeded
        ↓
本案例最关键的根因证据

ContainerStatuses
        ↓
Error / ContainerStatusUnknown / 137
        ↓
解释各个容器最终如何结束
```

---

## 总结

这次故障可以归纳为：

```text
Pod ephemeral-storage 超过 2Gi 限制
        ↓
kubelet 驱逐 Pod
        ↓
Pod Phase = Failed
Pod Reason = Evicted
        ↓
容器被终止
        ↓
部分容器显示 Error / Exit 137
部分容器显示 ContainerStatusUnknown
        ↓
kubectl get pods 可能展示容器终止原因
        ↓
Deployment / ReplicaSet 创建替代 Pod
        ↓
旧 Failed Pod API 对象仍然保留
        ↓
等待用户、Controller 或 PodGC 清理
```

最重要的两点：

1. **`kubectl get pods` 的 STATUS 是展示结果，不要把它当作唯一根因字段。**
2. **优先看 `.status.reason`、`.status.message` 和 `kubectl describe pod`，然后再结合 ContainerStatus 分析终止细节。**

---

## References

- Kubernetes: Pod lifecycle  
  https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- Kubernetes: Local ephemeral storage  
  https://kubernetes.io/docs/concepts/storage/ephemeral-storage/
- Kubernetes: Node-pressure eviction  
  https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/
- Kubernetes: kube-controller-manager `--terminated-pod-gc-threshold`  
  https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/
- Kubernetes source: Pod STATUS printer  
  https://github.com/kubernetes/kubernetes/blob/master/pkg/printers/internalversion/printers.go
