---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes HPA CPU 扩缩容详解：requests、averageUtilization 与 Resource / ContainerResource"
description: "用一个双容器 Pod 的实际配置说明 Kubernetes HPA 如何根据 CPU requests 计算利用率、limits 为什么不参与目标计算，以及 Resource 和 ContainerResource 应该怎么选。"
pubDate: "2026-09-21"
category: Kubernetes
tags:
  - Kubernetes
  - HPA
  - Autoscaling
  - CPU
  - Resource
  - ContainerResource
enPath: "/blog/kubernetes-hpa-cpu-resource-containerresource/"
zhPath: "/zh/blog/kubernetes-hpa-cpu-resource-containerresource/"
---

最近重新看了一次 HPA 配置。配置本身并不复杂，但 Pod 里只要有多个容器，就很容易把 `requests`、`limits` 和 `averageUtilization` 的关系理解错。

实际配置大致是这样：

```text
容器 1：
  requests.cpu = 100m
  limits.cpu   = 1000m

容器 2：
  requests.cpu = 10m
  limits.cpu   = 12000m
```

HPA：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: app-001
spec:
  minReplicas: 1
  maxReplicas: 4
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: app-001
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 200
```

最开始的问题其实很直接：

> 两个容器的 requests 和 limits 差这么多，那么 Pod 到底使用多少 CPU 时，HPA 才会扩容？

关键点只有一个：

> **`averageUtilization` 是相对于 CPU requests 计算的，不是相对于 CPU limits。**

## 先看 requests：HPA 的 CPU 利用率以它为基准

当 HPA 配置为：

```yaml
target:
  type: Utilization
  averageUtilization: 200
```

这里的利用率，是当前 CPU 使用量相对于 CPU request 的百分比。

对于使用 `Resource` 类型指标的多容器 Pod，可以先用下面这个方式理解：

```text
Pod CPU 利用率
=
Pod 内各容器 CPU 当前使用量之和
/
Pod 内各容器 CPU requests 之和
```

当前这个 Pod：

```text
requests.cpu 总量
=
100m + 10m
=
110m
```

目标是 `200%`：

```text
110m × 200%
=
220m
```

所以从配置含义上说，`220m` 就是这个 Pod 在 `200%` 目标下对应的 CPU 使用量。

但这里一定要加一句：

> **220m 是目标值，不是“超过 220m 一点点就一定立刻扩容”的硬阈值。**

HPA 真正计算副本数时还会考虑当前/目标指标比例、容差、指标缺失、Pod Ready 状态以及扩缩容行为策略等因素。

## CPU limits 不参与 averageUtilization 的分母

两个容器的 limit 是：

```text
容器 1：1000m
容器 2：12000m
```

加起来一共：

```text
13000m
```

但 HPA 不会拿这 `13000m` 来算 `averageUtilization`。

对于：

```yaml
target:
  type: Utilization
```

真正参与利用率计算的是 request。

所以当前配置里：

```text
requests 总量 = 110m
limits 总量   = 13000m
```

HPA 的 `200%` 目标仍然基于 `110m`，而不是 `13000m`。

CPU limit 当然仍然有意义，它会影响容器最多能用到多少 CPU，以及超过限制后是否出现 CPU throttling。

只是它和 HPA 的这个利用率百分比不是一回事。

## CPU 利用率超过 100% 完全正常

如果某个容器：

```text
requests.cpu = 100m
```

实际使用：

```text
300m
```

那么利用率就是：

```text
300m / 100m = 300%
```

所以 `200%`、`300%`、`500%` 这些数字本身都不表示 CPU 已经超过物理上限。

它只是说明当前 CPU 使用量是 request 的多少倍。

## HPA 需要的是 requests，不是必须同时有 limits

以前很容易看到这种说法：

> HPA 基于 CPU 扩缩容时，每个容器都应该同时配置 requests 和 limits。

这个说法需要拆开看。

对于 `type: Utilization`，真正用于计算利用率的是 **request**。

HPA 并不要求你必须为了它额外配置 CPU limit。

```yaml
resources:
  requests:
    cpu: 100m
```

已经可以为 CPU 利用率提供基准。

但对 `Resource` 类型 CPU 指标，如果 Pod 中某个容器没有设置对应的 CPU request，那么 Kubernetes 无法正常计算这个 Pod 的 CPU utilization，HPA 也无法正常基于这个利用率指标做判断。

所以真正应该记住的是：

> **CPU utilization 类型的 HPA，requests 很重要；limits 不是计算这个百分比的必要条件。**

## HPA 到底怎么计算副本数

HPA 的基本公式可以简化成：

```text
desiredReplicas
=
ceil(
  currentReplicas
  ×
  currentMetricValue / desiredMetricValue
)
```

还是当前这个例子。

目标：

```text
200%
```

假设现在只有 1 个 Pod，当前平均 CPU 利用率变成：

```text
300%
```

那么：

```text
desiredReplicas
=
ceil(1 × 300 / 200)
=
2
```

如果现在已经有 2 个 Pod，并且它们的平均利用率仍然是 `300%`：

```text
desiredReplicas
=
ceil(2 × 300 / 200)
=
3
```

所以理解 HPA 时，比“多少毫核触发”更重要的是：

```text
当前指标 / 目标指标
```

这个比例。

## 默认 10% tolerance 也会影响扩容

HPA 默认会忽略目标附近的小幅波动。

默认集群级 tolerance 是 `10%`，除非管理员修改过相关配置。

当前 HPA：

```text
target = 200%
```

按默认 10% 容差做一个便于理解的近似：

```text
200% × 1.10
=
220% utilization
```

对应当前 Pod 的 CPU request：

```text
110m × 220%
≈ 242m
```

因此可以这样理解：

```text
220m = 200% 的目标位置
约 242m = 默认 10% 容差上沿附近
```

但千万不要进一步写成：

> CPU 一到 242m，HPA 就一定扩容。

因为真正的控制器还会处理：

- 缺失的 metrics；
- 尚未 Ready 的 Pod；
- CPU 初始化阶段；
- HPA 控制循环；
- scaleUp / scaleDown policy；
- stabilization 行为。

所以这些数值适合帮助理解，不适合当成精确到某一时刻的触发器。

## 为什么这个双容器配置特别容易把人绕进去

两个 request 相差很大：

```text
容器 1 request = 100m
容器 2 request = 10m
```

`Resource` 类型会把两个容器混合成一个 Pod 级别的 CPU 信号。

例如：

```text
容器 1 当前 CPU = 180m
容器 2 当前 CPU = 5m

总使用量 = 185m
总 request = 110m

Pod CPU utilization ≈ 168%
```

HPA 看到的大约就是 `168%`，低于 `200%` 目标。

再换一个：

```text
容器 1 当前 CPU = 250m
容器 2 当前 CPU = 5m

总使用量 = 255m
总 request = 110m

Pod CPU utilization ≈ 232%
```

这时 HPA 看到的就是高于目标的值。

问题在于：

> 这个混合后的 Pod 利用率，真的是你想用来判断业务压力的指标吗？

如果容器 1 是主业务，容器 2 只是日志、代理或者监控 sidecar，那么 sidecar 的 request 和实际 CPU 同样会进入这个 Pod 总体指标。

这时就要考虑 `ContainerResource`。

## Resource 和 ContainerResource 到底有什么区别

`autoscaling/v2` 可以使用 `Resource` 和 `ContainerResource` 两种方式。

### Resource：看整个 Pod

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: hpa-resource-example
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-deployment
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
```

对于多容器 Pod，它会把相关容器的 CPU usage 和 requests 汇总成 Pod 级别的利用率信号。

适合：我就是希望根据整个 Pod 的 CPU 压力进行扩缩容。

### ContainerResource：只看指定容器

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: hpa-container-resource-example
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-deployment
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: ContainerResource
      containerResource:
        name: cpu
        container: application
        target:
          type: Utilization
          averageUtilization: 80
```

这里 HPA 只关注 `application` 这个容器在各个 Pod 中的 CPU 利用率。

日志 sidecar、代理 sidecar、exporter 等其他容器不会再混进这个 HPA 指标。

如果真正能反映请求压力的是 `application`，那用它作为 HPA 指标通常会比把所有容器混在一起更直观。

## ContainerResource 已经不是 1.27 时代的 Beta 功能了

原来的笔记里还有：

```text
Kubernetes 1.27
HPAContainerMetrics
Beta
默认开启
```

这在 Kubernetes 1.27 时是正确的。

但现在已经过时。

`ContainerResource` 从 **Kubernetes 1.30 开始已经 Stable**，相关 feature gate 也已经被移除。

所以对于现代 Kubernetes 集群，不需要再去 `kube-controller-manager` 里寻找或者开启 `HPAContainerMetrics`。

如果维护的是老版本集群，还是应该对应查看那个 Kubernetes 版本的官方文档。

## 怎么选 Resource 还是 ContainerResource

适合 `Resource`：

- Pod 本身就应该作为一个整体看待；
- 多个容器都和业务负载相关；
- 希望按整个 Pod 的 CPU / 内存压力扩缩容。

适合 `ContainerResource`：

- 一个容器才是真正的主业务；
- sidecar CPU 行为和业务请求量关系不大；
- 不同容器 requests 差异很明显；
- Pod 总利用率把真正关键容器的压力稀释掉了。

例如：

```text
application:
  requests.cpu = 100m

sidecar:
  requests.cpu = 10m
```

我会先问一句：

> 我要因为整个 Pod CPU 高而扩容，还是因为 application 忙而扩容？

这个问题通常就能决定用哪个类型。

## 改 HPA 前，我一般先看什么

实际环境里我不会直接改 YAML。

先看：

```bash
kubectl get hpa -A
kubectl describe hpa <hpa-name> -n <namespace>
kubectl top pod <pod-name> -n <namespace> --containers
```

然后检查 Deployment：

```bash
kubectl get deploy <deployment-name> -n <namespace> -o yaml
```

重点把这些东西放在一起看：

```text
每个容器当前 CPU usage
每个容器 CPU requests
HPA current metric
HPA target metric
current replicas
desired replicas
```

还可以直接观察：

```bash
kubectl get hpa <hpa-name> -n <namespace> -w
```

比只盯着 CPU limits 有用得多。

## 还有一个坑：requests 设置本身会改变 HPA 的信号

因为 HPA utilization 是相对于 requests 算的，所以 request 值是否合理非常重要。

假设两个应用都实际使用：

```text
200m CPU
```

但 request 不一样：

```text
Pod A request = 100m
Pod B request = 500m
```

得到：

```text
Pod A utilization = 200%
Pod B utilization = 40%
```

CPU 实际使用量完全一样，但 HPA 看到的信号差了 5 倍。

所以 HPA 调优和 `resources.requests` 调优是关联的。

request 配得太小，HPA 可能显得很激进。

request 配得太大，HPA 可能显得很迟钝。

当然也不能为了让 HPA 数字“好看”就随便调 requests，因为 requests 同时还关系到 Scheduler 调度和节点资源规划。

更合理的方式是先给出尽可能符合实际负载的 requests，再根据业务需要确定 HPA target。

## 回到最开始的这个例子

原配置：

```text
容器 1 request = 100m
容器 2 request = 10m

Resource CPU target = 200%
```

可以先这样理解：

```text
CPU requests 总量 = 110m

200% target
≈ 220m Pod 总 CPU 使用量
```

但同时要记住：

- `220m` 是目标点，不是精确的瞬时扩容开关；
- CPU limits 不参与 `averageUtilization` 的分母；
- CPU utilization 类型 HPA 依赖 CPU requests；
- HPA 根据当前指标 / 目标指标比例计算期望副本数；
- tolerance、Pod readiness 和缺失指标都会影响最终扩缩容；
- `Resource` 看到的是 Pod 级别的混合信号；
- `ContainerResource` 可以只跟踪真正关键的容器；
- `ContainerResource` 从 Kubernetes 1.30 起已经 Stable。

以后再碰到这种 HPA 配置，我会先看：

```text
requests
+
metric type
```

最后才去看 limits。

## 参考资料

- [Kubernetes 官方文档：Pod 水平自动扩缩](https://kubernetes.io/zh-cn/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- [Kubernetes 官方文档：HorizontalPodAutoscaler 演练](https://kubernetes.io/zh-cn/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [Kubernetes 1.27：HorizontalPodAutoscaler ContainerResource 类型指标进阶至 Beta](https://kubernetes.io/zh-cn/blog/2023/05/02/hpa-container-resource-metric/)
- [Kubernetes 应用最佳实践 - 水平自动伸缩](https://dbwu.tech/posts/k8s/best_practice/hpa/)
- [Kubernetes HPA 设计与实现](https://dbwu.tech/posts/k8s/source_code/hpa_controller/)
