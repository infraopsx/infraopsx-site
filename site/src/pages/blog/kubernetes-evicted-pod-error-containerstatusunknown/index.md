---
layout: ../../../layouts/ArticleLayout.astro
title: "Why Does an Evicted Kubernetes Pod Show Error or ContainerStatusUnknown?"
description: "A practical Kubernetes troubleshooting case: why a Pod evicted for exceeding ephemeral-storage can still appear as Error or ContainerStatusUnknown, why the old Pod remains after a replacement starts, and how to identify the real root cause."
pubDate: "2026-09-19"
category: Kubernetes
tags:
  - Kubernetes
  - Troubleshooting
  - Storage
  - Containers
enPath: "/blog/kubernetes-evicted-pod-error-containerstatusunknown/"
zhPath: "/zh/blog/kubernetes-evicted-pod-error-containerstatusunknown/"
---

> This article is based on a real Kubernetes troubleshooting case. Namespaces, Pod and container names, registry addresses, IPs, paths, ConfigMaps, labels, and business-specific identifiers have been anonymized without changing the technical behavior.

## The symptom

A cluster contained failed Pods that remained visible for days:

```bash
kubectl -n prod-team-a get pod edge-proxy-7d9c7f8d8d-k2m4x
```

```text
NAME                            READY   STATUS   RESTARTS   AGE
edge-proxy-7d9c7f8d8d-k2m4x     0/2     Error    1          3d4h
```

Another Pod showed:

```bash
kubectl -n prod-team-b get pod platform-service-68df8c6d79-v7n2p
```

```text
NAME                               READY   STATUS                   RESTARTS   AGE
platform-service-68df8c6d79-v7n2p  0/2     ContainerStatusUnknown   2          2d8h
```

Meanwhile, the Deployment / ReplicaSet had already created replacement Pods and the workload was healthy again.

That raises several questions:

1. Why did the old Pods remain?
2. Why did `kubectl get pods` show `Error` or `ContainerStatusUnknown` instead of `Evicted`?
3. What does exit code `137` really mean?
4. Which field reveals the actual root cause?

---

## The short answer

The important evidence was not:

```text
Error
ContainerStatusUnknown
```

The Pod-level state was:

```text
Status:   Failed
Reason:   Evicted
Message:  Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

So the actual sequence was:

```text
ephemeral-storage limit exceeded
        ↓
kubelet evicts the Pod
        ↓
Pod Phase = Failed
Pod Reason = Evicted
```

`Error` and `ContainerStatusUnknown` were container termination states that can influence the human-readable `STATUS` column produced by `kubectl get pods`.

The first lesson is:

> **Do not treat the `STATUS` column from `kubectl get pods` as the only source of truth for root-cause analysis.**

---

## 1. The `STATUS` column is not the same as `.status.reason`

For example:

```bash
kubectl get pod -n prod-team-a edge-proxy-7d9c7f8d8d-k2m4x
```

may show:

```text
STATUS
Error
```

while:

```bash
kubectl describe pod -n prod-team-a edge-proxy-7d9c7f8d8d-k2m4x
```

shows:

```text
Status:   Failed
Reason:   Evicted
Message:  Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

These outputs are not contradictory.

The `STATUS` column printed by `kubectl get pods` is a presentation value. It is not a standalone Pod API field.

When generating that column, `kubectl` considers information such as:

- Pod phase
- Pod reason
- init-container state
- container waiting reason
- container terminated reason

As a result, the Pod API can contain:

```text
phase  = Failed
reason = Evicted
```

while the CLI display ends up showing:

```text
Error
```

or:

```text
ContainerStatusUnknown
```

### Query the actual Pod fields

A better check is:

```bash
kubectl get pod -n prod-team-a edge-proxy-7d9c7f8d8d-k2m4x \
  -o jsonpath='{.status.phase}{"\n"}{.status.reason}{"\n"}{.status.message}{"\n"}'
```

Example:

```text
Failed
Evicted
Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

For root-cause analysis, these fields are more useful than the summary column alone.

---

## 2. What does ContainerStatusUnknown mean?

One sidecar in this incident had a termination state similar to:

```text
State:       Terminated
Reason:      ContainerStatusUnknown
Message:     The container could not be located when the pod was terminated
Exit Code:   137
```

`ContainerStatusUnknown` does not necessarily mean Kubernetes lost the entire Pod.

It means the kubelet could not obtain a valid container status from the container runtime when constructing the terminated state.

For example, the container may already have been removed or the runtime may no longer be able to return the original container information.

That is why messages such as this can appear:

```text
The container could not be located when the pod was terminated
```

In this case, the higher-level Pod status already provided a much stronger clue:

```text
Reason: Evicted
```

So `ContainerStatusUnknown` describes part of the termination aftermath; it should not automatically be treated as the original failure cause.

---

## 3. The actual cause: ephemeral-storage exceeded its limit

The most important line in `kubectl describe pod` was:

```text
Message: Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
```

The resource configuration was similar to:

```yaml
resources:
  requests:
    ephemeral-storage: 100Mi
  limits:
    ephemeral-storage: 2Gi
```

When kubelet manages local ephemeral storage and a Pod or container exceeds the configured limit, the Pod can be marked for eviction.

Kubernetes local ephemeral storage commonly includes:

- container writable layers
- node-level container logs
- non-`tmpfs` `emptyDir` volumes
- other kubelet-managed local temporary storage

This means `ephemeral-storage` should not be interpreted simply as:

```text
the size of /tmp
```

A workload that continuously emits logs can also consume local ephemeral storage even if it does not intentionally write business data into the container filesystem.

---

## 4. Exit code 137 does not automatically mean OOM

The incident also showed:

```text
Exit Code: 137
```

The number can be read as:

```text
128 + 9 = 137
```

and signal 9 is:

```text
SIGKILL
```

So we can safely conclude that the container was ultimately killed forcibly.

However, **137 alone does not identify why**.

Possible causes include:

- OOM kill
- forced termination by kubelet
- termination during Pod eviction
- exceeding `terminationGracePeriodSeconds`
- an explicit force-kill operation
- node or container-runtime state reconstruction

Therefore, this is not a safe conclusion:

```text
137 means the root cause was OOM.
```

Nor is this:

```text
137 always means the process ignored SIGTERM for 30 seconds.
```

In this case we have stronger direct evidence:

```text
Reason:  Evicted
Message: Pod ephemeral local storage usage exceeds ...
```

The root cause should therefore be identified as:

> **eviction caused by excessive ephemeral-storage usage.**

---

## 5. Why does the failed Pod remain after a replacement is running?

This is normal Kubernetes behavior.

Suppose the failed Pod is managed by a Deployment:

```text
Deployment
    ↓
ReplicaSet
    ↓
Old Pod → Failed / Evicted
```

When the ReplicaSet controller sees that the desired replica count is no longer satisfied, it can create another Pod:

```text
Old Pod → Failed
New Pod → Running
```

Creating a replacement and deleting the old Pod API object are separate operations.

Failed Pod objects can remain in the API until they are:

- explicitly deleted by a user;
- removed by a controller;
- cleaned up by Pod garbage collection.

So this is entirely possible:

```text
edge-proxy-old     0/2   Error     ...
edge-proxy-new     2/2   Running   ...
```

The workload can be healthy again while the old failed Pod object is still visible.

---

## 6. Why doesn't PodGC remove it immediately?

`kube-controller-manager` exposes:

```text
--terminated-pod-gc-threshold
```

which controls how many terminated Pods can exist before the terminated-Pod garbage collector begins deleting them.

The current Kubernetes documentation lists the default as:

```text
12500
```

This is why a small number of old Failed / Evicted Pods can remain visible for a long time.

A Pod that was evicted days ago can therefore still appear in:

```bash
kubectl get pods
```

without indicating that the replacement workload is unhealthy.

---

## 7. A better troubleshooting sequence

When you see:

```text
Error
ContainerStatusUnknown
Evicted
Unknown
```

avoid guessing from the display value.

### Step 1: query Pod phase, reason, and message

```bash
kubectl get pod -n <namespace> <pod> \
  -o jsonpath='{.status.phase}{"\n"}{.status.reason}{"\n"}{.status.message}{"\n"}'
```

This is usually the most important first step.

### Step 2: describe the Pod

```bash
kubectl describe pod -n <namespace> <pod>
```

Focus on:

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

### Step 3: inspect termination reasons per container

```bash
kubectl get pod -n <namespace> <pod> \
  -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.state.terminated.reason}{"\t"}{.state.terminated.exitCode}{"\n"}{end}'
```

Example:

```text
network-helper      ContainerStatusUnknown   137
proxy-service       Error                    137
```

### Step 4: identify the owning controller

```bash
kubectl get pod -n <namespace> <pod> \
  -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}{"/"}{.name}{"\n"}{end}'
```

Example:

```text
ReplicaSet/edge-proxy-7d9c7f8d8d
```

If a healthy replacement already exists, separate these two questions:

```text
Is the workload healthy now?
```

and:

```text
Why is the old Pod object still present?
```

---

## 8. List Failed Pods directly from the API phase

For one namespace:

```bash
kubectl get pods -n <namespace> --field-selector=status.phase=Failed
```

Across namespaces:

```bash
kubectl get pods -A --field-selector=status.phase=Failed
```

To inspect reasons and messages:

```bash
kubectl get pods -A --field-selector=status.phase=Failed \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,REASON:.status.reason,MESSAGE:.status.message'
```

This is generally more useful than filtering the human-readable output with:

```bash
kubectl get pods -A | grep -E 'Error|Unknown'
```

---

## 9. Can a Failed / Evicted Pod be deleted?

First confirm that:

1. the Pod phase is `Failed`;
2. the workload is managed by a controller, or the old Pod is no longer needed;
3. a healthy replacement is running if the workload should remain available.

Then the old Pod can be removed:

```bash
kubectl delete pod -n <namespace> <pod>
```

For a terminated Pod, this mainly removes its API object.

But cleanup is not the fix.

If the workload repeatedly exceeds its `ephemeral-storage` limit, deleting old Pods only hides the symptom temporarily.

---

## 10. How should an ephemeral-storage problem be fixed?

### Find what is writing data

Check whether the workload continuously writes to:

```text
/tmp
/var/tmp
application cache directories
the container writable layer
emptyDir volumes
local log directories
```

### Check log growth

Large stdout / stderr streams also consume node-local storage.

Review:

- abnormal per-Pod log growth
- repeated log loops
- container-runtime log rotation
- fast growth in node Pod-log directories

### Do not blindly increase the limit

Changing:

```yaml
limits:
  ephemeral-storage: 2Gi
```

to:

```yaml
limits:
  ephemeral-storage: 20Gi
```

may only postpone the next incident.

The important questions are:

```text
What is writing?
Where is it writing?
Why does it keep growing?
Should this data be persistent?
Are logs rotating correctly?
```

### Move persistent data out of ephemeral storage

Data that must survive should normally use an appropriate persistent destination, for example:

```text
PersistentVolume
object storage
an external logging platform
a dedicated data volume
```

---

## 11. Check the node as well

For local-storage incidents, check the node filesystem:

```bash
df -h
df -i
```

Then, depending on the runtime and node layout:

```bash
du -xhd1 /var/log 2>/dev/null | sort -h
du -xhd1 /var/lib/containerd 2>/dev/null | sort -h
```

Directory layouts differ between Kubernetes distributions and container runtimes.

Also inspect the node:

```bash
kubectl describe node <node>
```

and check for:

```text
DiskPressure
```

One important distinction:

> A Pod exceeding its own `ephemeral-storage` limit and a whole node entering `DiskPressure` are related local-storage problems, but they are not the same condition.

In this case, the direct evidence pointed to the Pod's own ephemeral-storage usage exceeding its configured limit.

---

## 12. A practical mental model

When you see:

```text
Error
ContainerStatusUnknown
Exit Code 137
```

do not immediately invent three independent root causes.

Follow the layers:

```text
kubectl get pods
        ↓
human-readable summary

Pod .status.phase / .status.reason / .status.message
        ↓
Failed / Evicted / ephemeral-storage exceeded
        ↓
primary root-cause evidence in this incident

ContainerStatuses
        ↓
Error / ContainerStatusUnknown / 137
        ↓
details about how individual containers ended
```

This is much more reliable than diagnosing a Pod from the `STATUS` column alone.

---

## Summary

The incident can be reduced to this sequence:

```text
Pod exceeds its 2Gi ephemeral-storage limit
        ↓
kubelet evicts the Pod
        ↓
Pod Phase = Failed
Pod Reason = Evicted
        ↓
containers are terminated
        ↓
some container states become Error / exit 137
others become ContainerStatusUnknown
        ↓
kubectl get pods may display a container termination reason
        ↓
Deployment / ReplicaSet creates a replacement
        ↓
old Failed Pod API object remains
        ↓
user, controller, or PodGC eventually removes it
```

The two most useful lessons are:

1. **The `STATUS` column from `kubectl get pods` is a presentation value, not the only root-cause field.**
2. **Start with `.status.reason`, `.status.message`, and `kubectl describe pod`, then use container status to understand termination details.**

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
