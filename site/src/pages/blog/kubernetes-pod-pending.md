---
layout: ../../layouts/ArticleLayout.astro
title: "Kubernetes Pod Stuck in Pending: A Practical Troubleshooting Workflow"
description: "A systematic way to diagnose Pending pods using scheduler events, resource requests, affinity rules, taints and storage."
pubDate: 2026-09-18
locale: en
tags:
  - Kubernetes
  - Troubleshooting
  - Linux
enPath: /blog/kubernetes-pod-pending/
zhPath: /zh/blog/kubernetes-pod-pending/
---

A Kubernetes Pod in `Pending` state tells you something very specific:

**the Pod has been accepted by the cluster, but it is not ready to run yet.**

The important question is *why*.

Randomly restarting the Pod, deleting it, or adding more replicas rarely helps. A better approach is to identify which stage is blocking the Pod and work from the scheduler's own evidence.

This is the workflow I normally use.

---

## 1. Start with Events, not guesses

The first commands I run are:

```bash
kubectl get pod -n <namespace> <pod-name> -o wide
kubectl describe pod -n <namespace> <pod-name>
```

At the bottom of `kubectl describe`, check the **Events** section.

A scheduler message might look like this:

```text
0/6 nodes are available:
2 node(s) didn't match pod affinity rules,
4 Insufficient cpu.

preemption:
0/6 nodes are available:
2 Preemption is not helpful for scheduling,
4 No preemption victims found for incoming pod.
```

That single message already tells us much more than the `Pending` status itself.

In this example:

- 2 nodes are excluded by affinity rules.
- 4 nodes do not have enough allocatable CPU for the Pod's request.
- Kubernetes also checked whether preemption could help.
- It could not find suitable lower-priority Pods to evict.

This is no longer a generic Kubernetes problem. It is a **scheduling constraint problem**.

---

## 2. Check whether the Pod is actually unscheduled

Not every `Pending` Pod is waiting for the scheduler.

Check:

```bash
kubectl get pod -n <namespace> <pod-name> \
  -o jsonpath='{.spec.nodeName}{"\n"}'
```

If the result is empty, the Pod has not been assigned to a node.

That means you should focus on:

- resource requests
- node selectors
- affinity / anti-affinity
- taints and tolerations
- topology spread constraints
- PVC binding
- scheduler policy

If a node name is already present, the scheduler has done its job and the problem is probably later in the startup path.

Examples include:

- volume attachment
- image pulling
- container creation
- CNI networking

This distinction saves a lot of time.

---

## 3. Inspect CPU and memory requests

Kubernetes schedules based on **requests**, not on what a container happens to be using at this exact moment.

Check the Pod:

```bash
kubectl describe pod -n <namespace> <pod-name>
```

Look for:

```text
Requests:
  cpu:
  memory:
```

You can also inspect the workload definition:

```bash
kubectl get deployment -n <namespace> <deployment-name> -o yaml
```

Then inspect the nodes:

```bash
kubectl describe node <node-name>
```

Pay attention to:

```text
Allocatable
Allocated resources
```

A node can appear almost idle in `top` while still being unavailable to the scheduler because existing Pods have already reserved most of its allocatable CPU through requests.

For current utilization, also check:

```bash
kubectl top nodes
kubectl top pods -A
```

But remember:

> **usage and scheduler reservation are different things.**

---

## 4. Inspect affinity, anti-affinity and node selectors

If Events mention affinity rules, inspect the Pod specification:

```bash
kubectl get pod -n <namespace> <pod-name> -o yaml
```

Look for:

```yaml
nodeSelector:
```

and:

```yaml
affinity:
```

especially:

```yaml
nodeAffinity:
podAffinity:
podAntiAffinity:
```

A common failure mode is combining several valid rules until almost no node can satisfy all of them.

For example:

- the Pod must run on nodes with label A
- it must stay near workload B
- it must stay away from workload C
- only a few nodes have enough CPU

Individually, each rule may make sense.

Together, they may reduce the scheduling candidates to zero.

Check node labels with:

```bash
kubectl get nodes --show-labels
```

For a cleaner view:

```bash
kubectl get nodes \
  -L kubernetes.io/hostname \
  -L topology.kubernetes.io/zone
```

---

## 5. Check taints and tolerations

A node may have enough resources and still reject the Pod because of a taint.

Check:

```bash
kubectl describe node <node-name> | grep -A3 Taints
```

Or:

```bash
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
TAINTS:.spec.taints
```

Then inspect the Pod's tolerations:

```bash
kubectl get pod -n <namespace> <pod-name> \
  -o jsonpath='{.spec.tolerations}'
```

Typical taints include dedicated workload nodes, control-plane nodes, GPU nodes or temporarily unhealthy nodes.

Do not add a toleration blindly.

First ask:

**Should this workload really be allowed on that node?**

---

## 6. Check PVC and storage binding

A Pod can remain unscheduled because its PersistentVolumeClaim cannot be satisfied.

Check:

```bash
kubectl get pvc -n <namespace>
```

Then:

```bash
kubectl describe pvc -n <namespace> <pvc-name>
```

Useful information includes:

- StorageClass
- access mode
- requested capacity
- binding mode
- provisioning errors

Also inspect the StorageClass:

```bash
kubectl get storageclass
kubectl describe storageclass <storage-class>
```

One important setting is:

```text
volumeBindingMode
```

With `WaitForFirstConsumer`, volume provisioning and Pod scheduling may depend on each other.

Storage topology can therefore become part of what initially looks like a scheduler problem.

---

## 7. Read the scheduler message literally

Scheduler Events are often surprisingly precise.

For example:

```text
0/6 nodes are available:
2 node(s) didn't match pod affinity rules,
4 Insufficient cpu.
```

Do not immediately ask:

> "Why is Kubernetes broken?"

Translate it into constraints:

| Constraint | Nodes excluded |
|---|---:|
| Affinity mismatch | 2 |
| Insufficient CPU | 4 |
| Remaining candidates | 0 |

Now the investigation is much smaller.

Possible solutions might include:

- correcting an overly strict affinity rule
- reducing an unnecessarily high CPU request
- moving another workload
- adding capacity
- changing topology
- allowing the Pod onto additional suitable nodes

The right fix depends on the original design intent.

---

## 8. Understand the preemption message

You may also see:

```text
Preemption is not helpful for scheduling
```

or:

```text
No preemption victims found for incoming pod
```

This does **not** mean preemption is broken.

It means the scheduler evaluated whether removing lower-priority Pods could create a valid placement and concluded that it would not solve the problem.

For example, evicting Pods cannot fix:

- an affinity mismatch
- an incompatible node selector
- a missing toleration
- a storage topology conflict

That is why the earlier constraints matter.

---

## A practical decision tree

When a Pod stays `Pending`, I normally reduce the problem in this order:

```text
Pod Pending
    |
    +-- nodeName empty?
    |       |
    |       +-- Yes
    |       |    |
    |       |    +-- Read scheduler Events
    |       |    +-- Check resource requests
    |       |    +-- Check nodeSelector / affinity
    |       |    +-- Check taints / tolerations
    |       |    +-- Check PVC / topology
    |       |
    |       +-- No
    |            |
    |            +-- Check volume attachment
    |            +-- Check image pull
    |            +-- Check CNI
    |            +-- Check container creation
    |
    +-- Verify after every change
```

This keeps the investigation evidence-driven.

---

## Common troubleshooting mistakes

### Deleting the Pod repeatedly

If the controller recreates the same specification, the new Pod will hit the same scheduler constraints.

### Looking only at CPU usage

The scheduler cares about requested resources and allocatable capacity, not only real-time utilization.

### Relaxing affinity without understanding why it exists

The rule may be protecting availability, topology or workload isolation.

### Adding tolerations everywhere

That can make Pods run on nodes they were intentionally kept away from.

### Treating every Pending Pod as the same problem

`Pending` is a state, not a root cause.

---

## Final takeaway

For an unscheduled Kubernetes Pod, the fastest starting point is usually:

```bash
kubectl describe pod <pod>
```

Then read the scheduler Events literally.

Most Pending investigations become much easier once you stop treating Kubernetes as a black box and instead turn the scheduler message into a list of concrete constraints.

**Diagnose first. Change second.**
