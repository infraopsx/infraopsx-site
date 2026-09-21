---
layout: ../../../layouts/ArticleLayout.astro
title: "Kubernetes HPA CPU Scaling Explained: requests, averageUtilization, Resource vs ContainerResource"
description: "How Kubernetes HPA calculates CPU utilization from requests, why limits do not set the HPA target, and when to use Resource or ContainerResource metrics."
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

I recently revisited an HPA configuration that looks simple at first, but becomes easy to misread once a Pod contains more than one container.

The Deployment had two containers:

```text
container-1:
  requests.cpu = 100m
  limits.cpu   = 1000m

container-2:
  requests.cpu = 10m
  limits.cpu   = 12000m
```

The HPA was configured like this:

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

The question was:

> With two very different CPU requests and limits, what CPU usage actually makes HPA scale the Deployment?

The important part is that `averageUtilization` is based on **CPU requests**, not CPU limits.

That sounds obvious after reading the documentation, but it has several consequences that are easy to miss.

## First: HPA needs CPU requests for utilization-based scaling

For a CPU metric with:

```yaml
target:
  type: Utilization
  averageUtilization: 200
```

Kubernetes calculates utilization relative to the CPU request.

For a Pod with multiple containers and a `Resource` metric, the useful mental model is:

```text
Pod CPU utilization
=
sum(current CPU usage of containers)
/
sum(CPU requests of containers)
```

In this example:

```text
requests.cpu total
=
100m + 10m
=
110m
```

Therefore a target utilization of `200%` corresponds to a nominal CPU usage of:

```text
110m × 200%
=
220m
```

So `220m` is the CPU usage that corresponds to the configured target.

But there is an important distinction:

> **220m is the target operating point, not a hard "220m + 1m means scale immediately" threshold.**

The real HPA algorithm also considers the ratio between the current and desired metric, tolerance, missing metrics, Pod readiness, and scaling behavior.

## CPU limits are not the denominator

A common mistake is to look at:

```text
container-1 limit = 1 CPU
container-2 limit = 12 CPU
```

and assume HPA somehow calculates against 13 CPUs.

It does not.

For `target.type: Utilization`, CPU limits do not define the HPA utilization percentage.

The limits still matter operationally because they determine how much CPU a container can consume before CPU throttling becomes relevant, but they do not replace `requests.cpu` in the HPA utilization calculation.

For this HPA:

```text
request total = 110m
limit total   = 13000m
```

The HPA target is still based on `110m`, not `13000m`.

This also explains why CPU utilization above 100% is perfectly possible.

For example, if a container requests `100m` but currently consumes `300m`:

```text
300m / 100m = 300%
```

That does not mean Kubernetes has somehow exceeded the physical CPU capacity of the node. It only means the container is consuming three times its requested CPU.

## Requests are required; limits are not required by HPA

Another point worth correcting is the common statement that CPU HPA requires both requests and limits.

For utilization-based HPA, the important field is the **request**.

A CPU limit is not required just so HPA can calculate CPU utilization.

For a `Resource` CPU metric, if a Pod has containers without the relevant CPU request, Kubernetes cannot calculate that Pod's CPU utilization correctly for this metric, and the HPA cannot use it normally for that utilization calculation.

So this is important:

```yaml
resources:
  requests:
    cpu: 100m
```

This is fundamental when you want HPA to scale on CPU utilization percentages.

## How HPA decides the desired replica count

The simplified HPA formula is:

```text
desiredReplicas
=
ceil(
  currentReplicas
  ×
  currentMetricValue / desiredMetricValue
)
```

Suppose there is currently one Pod.

The target is:

```text
200%
```

If the current average CPU utilization reaches:

```text
300%
```

then the simplified calculation becomes:

```text
desiredReplicas
=
ceil(1 × 300 / 200)
=
2
```

If there are already two replicas and their average utilization is still `300%`:

```text
desiredReplicas
=
ceil(2 × 300 / 200)
=
3
```

This is why it is better to think in terms of a ratio rather than a single raw CPU threshold.

## What about the default HPA tolerance?

By default, HPA ignores small deviations around the target. The default cluster-wide tolerance is 10% unless it has been changed.

With:

```text
target utilization = 200%
```

a small fluctuation around that value does not necessarily cause scaling.

Using the default 10% tolerance as a rough mental model, a scale-up decision generally needs the usage ratio to move beyond the tolerated range.

For this Pod:

```text
CPU request total = 110m
target             = 200%
nominal target     = 220m
```

A rough 10%-above-target point is:

```text
200% × 1.10 = 220% utilization

110m × 220%
≈ 242m CPU
```

That still should not be treated as an exact "242m means scale" trigger.

The controller also accounts for:

- missing metrics;
- Pods that are not yet Ready;
- CPU initialization behavior;
- HPA sync timing;
- scale-up and scale-down policies;
- stabilization behavior.

The `220m` and `242m` values are useful for understanding the configuration, not for predicting the exact millisecond at which another Pod appears.

## Why this configuration is easy to misunderstand

The two containers have very different requests:

```text
container-1 request = 100m
container-2 request = 10m
```

With a `Resource` CPU metric, both containers contribute to the Pod-level value.

Imagine this usage:

```text
container-1 current CPU = 180m
container-2 current CPU = 5m

total usage = 185m
total request = 110m

Pod utilization ≈ 168%
```

The HPA sees roughly `168%`, below the `200%` target.

Now imagine:

```text
container-1 current CPU = 250m
container-2 current CPU = 5m

total usage = 255m
total request = 110m

Pod utilization ≈ 232%
```

The HPA now sees a value above the target.

The problem is that this blended Pod-level number may or may not represent the behavior you actually care about.

If `container-1` is the main application and `container-2` is a sidecar, the sidecar's request and usage become part of the HPA signal even if the sidecar has little relationship to application traffic.

That is where `ContainerResource` becomes useful.

## Resource vs ContainerResource

With `autoscaling/v2`, HPA can use both `Resource` and `ContainerResource` metrics.

### Resource

A `Resource` metric evaluates resource utilization at the Pod level.

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

For a multi-container Pod, CPU usage and CPU requests from the containers are combined into the Pod-level utilization signal.

### ContainerResource

`ContainerResource` lets HPA watch one named container across the Pods instead of blending all containers into a single Pod-level utilization value.

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

In this configuration, the HPA tracks CPU utilization of the `application` container.

A logging sidecar, proxy, metrics exporter, or another auxiliary container no longer dilutes or inflates the HPA signal.

## ContainerResource is no longer a beta-only feature

Older notes often mention:

```text
HPAContainerMetrics feature gate
Kubernetes 1.27
Beta
```

That was correct for Kubernetes 1.27.

It is no longer current guidance.

`ContainerResource` has been a **stable feature since Kubernetes 1.30**, and the old feature gate has been removed.

If you are working with an older Kubernetes release, check the documentation for that specific version.

## Which one should I use?

Use `Resource` when:

- the Pod should be treated as one resource unit;
- all containers contribute meaningfully to the same workload;
- Pod-wide CPU or memory pressure is the signal you want.

Use `ContainerResource` when:

- one container represents the real application load;
- sidecars have resource behavior unrelated to application traffic;
- one container has much larger or smaller requests than the others;
- a blended Pod-level utilization value hides the container you actually care about.

For a Pod such as:

```text
application:
  requests.cpu = 100m

sidecar:
  requests.cpu = 10m
```

I would first ask:

> Do I want to scale because the entire Pod is consuming CPU, or because the application container is busy?

That question usually decides the metric type.

## A practical check before changing the HPA

Before editing the HPA, I normally inspect three things:

```bash
kubectl get hpa -A
kubectl describe hpa <hpa-name> -n <namespace>
kubectl top pod <pod-name> -n <namespace> --containers
```

Then inspect the workload requests:

```bash
kubectl get deploy <deployment-name> -n <namespace> -o yaml
```

What I want to compare is:

```text
container CPU usage
container CPU requests
HPA current metric
HPA target metric
current replicas
desired replicas
```

For example:

```bash
kubectl get hpa <hpa-name> -n <namespace> -w
```

This is much more useful than looking only at the CPU limit.

## One more trap: requests can distort the signal

Because utilization is measured relative to requests, the quality of the request values matters.

Suppose two identical application containers consume the same `200m` CPU:

```text
Pod A request = 100m
Pod B request = 500m
```

Their utilization values are:

```text
Pod A: 200%
Pod B:  40%
```

Same CPU usage, completely different HPA signal.

If requests are unrealistically low, HPA can appear too aggressive.

If requests are unrealistically high, HPA can appear too slow.

The answer is not to tune requests purely to manipulate HPA. Requests still affect scheduling and resource planning. The point is to choose realistic requests and understand that HPA uses them as the utilization baseline.

## Summary

For the original example:

```text
container-1 request = 100m
container-2 request = 10m
Resource CPU target = 200%
```

the useful mental model is:

```text
total CPU request = 110m

200% target
≈ 220m aggregate Pod CPU usage
```

But:

- `220m` is the target, not a hard instant scale-up threshold;
- CPU limits do not define `averageUtilization`;
- utilization-based CPU HPA depends on CPU requests;
- HPA calculates the desired replica count from the current/desired metric ratio;
- tolerance, readiness and missing metrics affect the final decision;
- `Resource` blends container usage into a Pod-level signal;
- `ContainerResource` can scale on one important container;
- `ContainerResource` has been stable since Kubernetes 1.30.

When an HPA configuration looks strange, I start with the requests and the metric type before looking at the limits.

## References

- [Kubernetes documentation: Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- [Kubernetes documentation: HorizontalPodAutoscaler walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [Kubernetes 1.27: HorizontalPodAutoscaler ContainerResource type metric moves to beta](https://kubernetes.io/blog/2023/05/02/hpa-container-resource-metric/)
- [Kubernetes 应用最佳实践 - 水平自动伸缩](https://dbwu.tech/posts/k8s/best_practice/hpa/)
- [Kubernetes HPA 设计与实现](https://dbwu.tech/posts/k8s/source_code/hpa_controller/)
