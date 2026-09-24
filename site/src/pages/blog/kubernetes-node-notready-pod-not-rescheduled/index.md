---
layout: ../../../layouts/ArticleLayout.astro
title: "Kubernetes Node NotReady: Why Pods Don't Reschedule to Another Node"
description: "A practical Kubernetes troubleshooting note: a Node is already NotReady, but the workload Pod does not recover on another Node as expected. It records several easy-to-miss checks around NoSchedule, NoExecute, tolerationSeconds, nodeName, and DaemonSets."
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

Recently I ran into an issue that is easy to misread at first.

The Node hosting a Pod had already failed, and `kubectl get nodes` showed that the Node was unhealthy, but the workload did not recover on another healthy Node as expected.

The first reaction is often:

> Is the scheduler stuck?

Sometimes it is a scheduling problem. Quite often, though, the reason is somewhere else: `NoSchedule`, `NoExecute`, `tolerationSeconds`, `nodeName`, or even the type of controller that owns the Pod.

The Kubernetes documentation for <a href="https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/" target="_blank" rel="noopener noreferrer">Taints and Tolerations</a> explains the mechanics in detail. This note focuses on the parts that are easy to miss during an incident.

## A Pod is not really "moved" to another Node

We often say:

> The Node failed, so Kubernetes should move the Pod elsewhere.

That wording is convenient, but it hides an important detail.

Kubernetes does not normally take a running Pod from `node-a` and move that same Pod to `node-b`.

What usually happens is closer to this:

```text
Node becomes unhealthy
↓
the old Pod is evicted or deleted
↓
Deployment / StatefulSet notices that the desired replica count is no longer met
↓
the controller creates a replacement Pod
↓
the scheduler chooses another eligible Node
```

That means a "Pod did not migrate" incident is easier to reason about if you split it into two questions:

```text
Why is the old Pod still bound to the failed Node?

Why was a replacement Pod not created or scheduled?
```

Those are not the same problem.

If the object is only a standalone Pod:

```yaml
apiVersion: v1
kind: Pod
```

there is no Deployment or StatefulSet controller waiting to create a replacement after that Pod disappears.

One of the first things I check is therefore:

```bash
kubectl get pod <pod-name> -o yaml
```

and then `metadata.ownerReferences`.

That quickly tells you whether you are looking at a Deployment, StatefulSet, DaemonSet, or a bare Pod.

## NoSchedule is not as absolute as it looks

Consider a Node with this taint:

```text
INFRA=true:NoSchedule
```

For example:

```bash
kubectl describe node node2-192-168-240-101 | grep Taint -A2
```

```text
Taints:             INFRA=true:NoSchedule
Unschedulable:      false
Lease:
```

Under normal scheduler behavior, a Pod without a matching toleration should not be scheduled onto this Node.

That part is straightforward.

Now look at this Pod:

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

There is no toleration for `INFRA=true:NoSchedule`, yet the Pod can still be bound to the Node:

```bash
kubectl get pods test-nodename -o wide
```

```text
NAME            READY   STATUS    RESTARTS   AGE   IP              NODE
test-nodename   1/1     Running   0          64m   10.233.108.30   node2-192-168-240-101
```

The reason is `nodeName`.

When `.spec.nodeName` is set manually, the normal scheduler selection path is bypassed. Kubernetes documents this behavior explicitly: a Pod can be bound to the named Node even when that Node has a `NoSchedule` taint that the Pod does not tolerate.

So a more useful mental model for `NoSchedule` is:

> Do not let the scheduler place new, non-tolerating Pods here.

It does not mean:

> No Pod can possibly exist on this Node.

This is also one reason I avoid hard-coding `nodeName` for ordinary workloads unless there is a very specific need.

## NoExecute is the one that matters to Pods already running

`NoExecute` is different.

It does not only affect future scheduling. It also affects Pods that are already bound to the Node.

Suppose a Node gets:

```text
INFRA=true:NoExecute
```

A Pod without a matching toleration cannot keep tolerating that taint.

If the Pod has:

```yaml
tolerations:
- key: "INFRA"
  operator: "Equal"
  value: "true"
  effect: "NoExecute"
  tolerationSeconds: 60
```

the meaning is roughly:

> Tolerate this matching `NoExecute` taint for 60 seconds.

That can be useful in production. A brief network or control-plane hiccup should not necessarily cause an immediate wave of evictions.

The easy-to-miss case is this:

```yaml
tolerations:
- key: "INFRA"
  operator: "Equal"
  value: "true"
  effect: "NoExecute"
```

There is no:

```yaml
tolerationSeconds:
```

For a matching `NoExecute` taint, that does **not** mean "wait for the default amount of time".

It means the toleration has no time limit.

The Kubernetes API definition states that an omitted `tolerationSeconds` means the Pod tolerates the matching `NoExecute` taint indefinitely.

## Where do not-ready and unreachable taints come from?

The `INFRA=true:NoExecute` example above is a taint that we added ourselves.

A failed Node is different. Kubernetes also maintains a set of built-in taints based on Node conditions.

The official Kubernetes reference page <a href="https://kubernetes.io/docs/reference/labels-annotations-taints/" target="_blank" rel="noopener noreferrer">Well-Known Labels, Annotations and Taints</a> lists these system-defined taints, including:

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
```

These are tied to the Node `Ready` condition.

A simplified view is:

```text
Ready=False
→ node.kubernetes.io/not-ready
```

and:

```text
Ready=Unknown
→ node.kubernetes.io/unreachable
```

So when `kubectl get nodes` shows a Node as `NotReady`, I do not stop there. I also inspect the real condition and taints:

```bash
kubectl describe node <node-name>
```

or:

```bash
kubectl get node <node-name> -o yaml
```

and then look at:

```text
Conditions
Taints
```

For example, in the Node object:

```yaml
status:
  conditions:
  - type: Ready
    status: "False"
```

or:

```yaml
status:
  conditions:
  - type: Ready
    status: "Unknown"
```

The distinction matters because it explains why one of those built-in failure taints appears on the Node.

## For a failed Node, check whether the Pod tolerates those failure taints

Now the earlier `NoExecute` discussion has some context.

Seeing an unlimited `NoExecute` toleration does not automatically explain why a Pod stayed bound after the Node failed.

You still need to check **which taint the toleration matches**.

For Node failure scenarios, the two important ones are usually:

```text
node.kubernetes.io/not-ready:NoExecute
```

and:

```text
node.kubernetes.io/unreachable:NoExecute
```

So during troubleshooting I look for Pod tolerations such as:

```yaml
tolerations:
- key: "node.kubernetes.io/not-ready"
  operator: "Exists"
  effect: "NoExecute"
```

or:

```yaml
tolerations:
- key: "node.kubernetes.io/unreachable"
  operator: "Exists"
  effect: "NoExecute"
```

If one of these matches and has no `tolerationSeconds`, then the Pod can remain bound indefinitely for that matching failure taint.

That is very different from an unrelated custom toleration such as:

```text
INFRA=true:NoExecute
```

A custom `INFRA` toleration does not automatically match `node.kubernetes.io/not-ready` or `node.kubernetes.io/unreachable`.

The taint key still has to match.

## Normal Pods usually get a five-minute grace period

A Node entering `NotReady` does not mean every Pod should disappear immediately.

Kubernetes documents this behavior in the <a href="https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-based-evictions" target="_blank" rel="noopener noreferrer">Taint Based Evictions</a> section.

For ordinary Pods, Kubernetes normally adds tolerations for:

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
```

with:

```text
tolerationSeconds: 300
```

unless those tolerations were already set explicitly by the user or a controller.

That is the familiar five-minute grace period.

So seeing a Pod remain bound for a few minutes after a Node problem is not necessarily a fault.

The delay is useful. If a Node only suffers a brief network interruption, immediately evicting every workload on it could make the incident much worse.

When I suspect this part of the lifecycle, I simply inspect the live Pod:

```bash
kubectl get pod <pod-name> -o yaml
```

and check:

```text
key
operator
effect
tolerationSeconds
```

Do not stop at "the Pod has tolerations". The important questions are what they match and how long they last.

## nodeName can also break the replacement path

There is another `nodeName` trap.

Suppose the workload is managed by a Deployment, but the Pod template contains:

```yaml
spec:
  template:
    spec:
      nodeName: node2-192-168-240-101
```

The old Pod may eventually be removed and the Deployment may create a replacement.

But the replacement Pod still contains:

```yaml
nodeName: node2-192-168-240-101
```

So the situation can look like:

> The Node is dead. Why won't Kubernetes schedule the new Pod somewhere else?

The answer is that the scheduler was never given that choice.

For ordinary workload placement, `nodeSelector` or node affinity is often a better way to express a placement constraint without pinning a Pod to one exact Node name.

## Check whether it is a DaemonSet before going too far

Another quick check is the owner.

```bash
kubectl get pod <pod-name> -o yaml
```

If `ownerReferences` shows:

```yaml
kind: DaemonSet
```

do not reason about it like a Deployment Pod.

DaemonSet Pods are created with `NoExecute` tolerations for `node.kubernetes.io/not-ready` and `node.kubernetes.io/unreachable` without `tolerationSeconds`.

That is intentional: those Pods are not evicted just because the Node becomes not ready or unreachable.

This is one of those details that can make a perfectly normal DaemonSet look like a broken rescheduling path if you are only watching `kubectl get pods`.

## The order I use when troubleshooting this

I normally start with the Node:

```bash
kubectl get nodes
```

Then inspect the affected Node:

```bash
kubectl describe node <node-name>
```

The parts I care about first are:

```text
Conditions
Taints
```

Then I look at the Pod:

```bash
kubectl get pod <pod-name> -o wide
```

and the full object:

```bash
kubectl get pod <pod-name> -o yaml
```

The fields that usually answer the question are:

```text
.spec.nodeName
.spec.nodeSelector
.spec.affinity
.spec.tolerations
.metadata.ownerReferences
```

For a Node failure, I specifically look for:

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
NoExecute
tolerationSeconds
```

If the old Pod is already gone but the replacement is `Pending`, then the problem has moved on. At that point I stop looking at eviction timing and start checking the usual scheduling path:

```text
taints / tolerations
nodeSelector / affinity
CPU / memory
PVC
storage topology
scheduler events
```

That is a much more ordinary Pending-Pod investigation.

If that is where you end up, the related InfraOpsX note [Kubernetes Pod Pending: a practical troubleshooting path](/blog/kubernetes-pod-pending/) is the next place to look.

## The few details worth remembering

`NoSchedule` mainly affects new scheduling. It does not evict Pods that are already running.

`nodeName` bypasses normal scheduler selection.

`NoExecute` affects Pods that are already bound to the Node.

For a matching `NoExecute` taint, omitting `tolerationSeconds` means the toleration does not expire.

During a Node failure, do not look at `NoExecute` in the abstract. Look specifically at:

```text
node.kubernetes.io/not-ready
node.kubernetes.io/unreachable
```

And most importantly, do not treat "the Pod did not move" as one single failure.

It can mean:

> The old Pod has not been evicted yet.

or:

> The old Pod is gone, but no controller owns it.

or:

> A replacement Pod exists, but it cannot be scheduled.

Once those cases are separated, this problem becomes much easier to reason about.

## References

- <a href="https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/" target="_blank" rel="noopener noreferrer">Kubernetes: Taints and Tolerations</a>
- <a href="https://kubernetes.io/docs/reference/labels-annotations-taints/" target="_blank" rel="noopener noreferrer">Kubernetes: Well-Known Labels, Annotations and Taints</a>
- <a href="https://kubernetes.io/docs/reference/kubernetes-api/definitions/toleration-v1/" target="_blank" rel="noopener noreferrer">Kubernetes API: Toleration</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_taint/" target="_blank" rel="noopener noreferrer">kubectl taint reference</a>
