---
layout: ../../../layouts/ArticleLayout.astro
title: "Upgrading a kubeadm Kubernetes Cluster from v1.27 to v1.37: A Real 5-Node Migration"
description: "A real kubeadm upgrade log from Kubernetes v1.27 toward v1.37 on a five-node Debian cluster. Part 1 covers why we first moved from v1.27.0 to the final v1.27.16 patch, backups, control-plane changes, worker drains, PDB blockers, and final verification."
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

This is a real upgrade log, not a clean-room kubeadm tutorial.

The cluster had been running for roughly 260 days on Kubernetes <code>v1.27.0</code>. The long-term goal is to bring it all the way to a current Kubernetes release without skipping minor versions. This first draft records the first checkpoint only:

~~~text
v1.27.0
  ↓
v1.27.16
~~~

That may look like an unnecessary detour. It was deliberate.

Before attempting <code>v1.28</code>, I first moved the whole cluster to <code>v1.27.16</code>, the **final patch release in the Kubernetes 1.27 series**. Kubernetes lists <code>1.27.16</code> as the final 1.27 patch and marks 1.27 as end-of-life. The project also states that skipping minor versions during kubeadm upgrades is unsupported.

So the migration strategy is:

~~~text
1.27.0
→ 1.27.16
→ 1.28.x
→ 1.29.x
→ ...
→ 1.37.x
~~~

This is not the only theoretically possible way to start the journey, and kubeadm does not require every cluster to stop at the final patch of the current minor before moving to the next minor. I chose it because it gives us a clean, fully patched checkpoint before crossing each minor-version boundary.

The official Kubernetes references behind that decision are:

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release page</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch release history</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>
- <a href="https://kubernetes.io/releases/version-skew-policy/" target="_blank" rel="noopener noreferrer">Kubernetes version skew policy</a>

## How did I choose v1.27.16?

I did not pick the version number from a blog post or package repository listing.

Kubernetes' own release history identifies:

~~~text
Kubernetes 1.27
Final patch release: 1.27.16
End of life: 2024-07-16
~~~

After replacing only the kubeadm binary with <code>v1.27.16</code>, the real cluster also confirmed the same target:

~~~text
[upgrade/versions] Cluster version: v1.27.0
[upgrade/versions] kubeadm version: v1.27.16
[upgrade/versions] Target version: v1.27.16
[upgrade/versions] Latest version in the v1.27 series: v1.27.16
~~~

That gave us two independent checks: the Kubernetes release history and kubeadm's own upgrade plan.

There was another useful lesson here. Before replacing kubeadm, an earlier check with the old <code>v1.27.0</code> kubeadm binary produced an outdated fallback mapping for the target etcd image. After kubeadm itself was updated to <code>v1.27.16</code>, <code>kubeadm upgrade plan</code> correctly selected etcd <code>3.5.12-0</code>.

For an old cluster, I would therefore avoid treating an old kubeadm binary as authoritative about the component versions bundled with a later patch. Upgrade the kubeadm binary first, verify it, and then generate the plan with the target kubeadm version.

## Cluster before the upgrade

This was a five-node kubeadm cluster:

| Node | Role | Kubernetes | OS | Runtime |
| --- | --- | --- | --- | --- |
| master | control-plane | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node1 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node2 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node3 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |
| node4 | worker | v1.27.0 | Debian 12 | containerd 1.6.20 |

All nodes were using kernel <code>6.1.0-52-amd64</code>.

The Kubernetes binaries were not installed through apt or rpm. They were manually installed under:

~~~text
/usr/local/bin/kubeadm
/usr/local/bin/kubelet
/usr/local/bin/kubectl
~~~

The kubelet systemd service also executed <code>/usr/local/bin/kubelet</code>.

That matters because the official kubeadm upgrade documentation usually shows package-manager commands. In this cluster the workflow was the same at the kubeadm level, but binary replacement and rollback had to be handled manually.

Other relevant baseline details:

~~~text
CNI: Calico v3.25.0 (manifest installation)
CoreDNS: v1.10.1
etcd: 3.5.7-0
containerd: 1.6.20
control-plane count: 1
worker count: 4
~~~

The cluster was healthy before any change:

~~~text
master   Ready
node1    Ready
node2    Ready
node3    Ready
node4    Ready
~~~

The API <code>/readyz?verbose</code> check passed.

There were already some <code>DNSConfigForming</code> warning events caused by the host resolver configuration. I recorded those before the upgrade so that I would not later mislabel them as an upgrade regression.

## Create a recovery checkpoint before touching the cluster

The first real step was not downloading Kubernetes. It was making a recovery point.

For this lab cluster I saved the checkpoint locally on the control-plane node. For a production or otherwise valuable cluster I would also copy it off-host before continuing.

The checkpoint included:

- the existing kubeadm, kubelet, and kubectl binaries
- kubeadm-config and kubelet configuration
- node and workload manifests
- <code>/etc/kubernetes</code>
- kubelet configuration files
- an etcd snapshot
- SHA256 checksums for the backup files

The etcd snapshot was successfully created before the upgrade. Its status was:

~~~text
revision: 38602084
total keys: 1182
total size: 19 MB
~~~

The snapshot itself was also checksummed.

One small compatibility detail appeared here: the etcd image in this cluster did not include <code>etcdutl</code>, so snapshot status was checked with the older:

~~~bash
etcdctl snapshot status
~~~

which printed a deprecation warning. The snapshot itself was healthy; the warning only affected the inspection command.

I also archived <code>/etc/kubernetes</code>. That archive contains private PKI material, including CA keys, so it is a recovery artifact, not something that should be attached to a public article or committed to Git.

## Replace kubeadm first and verify its checksum

Because the binaries were manually managed, I downloaded the target kubeadm binary directly and verified it before replacing the old one.

The recorded checksum validation was:

~~~text
kubeadm-v1.27.16: OK
33622018f83515331ac70c2041eba5d814a6d78a40b8869f089ea502f63a1421  kubeadm-v1.27.16
~~~

After replacement:

~~~text
/usr/local/bin/kubeadm
v1.27.16
~~~

I kept the old binary in the recovery checkpoint instead of overwriting it without a rollback path.

## Run kubeadm upgrade plan before applying anything

With target kubeadm in place, I ran the upgrade plan.

This was one of the most useful outputs in the whole first checkpoint:

~~~text
COMPONENT                 CURRENT   TARGET
kube-apiserver            v1.27.0   v1.27.16
kube-controller-manager   v1.27.0   v1.27.16
kube-scheduler            v1.27.0   v1.27.16
kube-proxy                v1.27.0   v1.27.16
CoreDNS                   v1.10.1   v1.10.1
etcd                      3.5.7-0   3.5.12-0
~~~

And kubeadm separately told us what it would **not** upgrade for us:

~~~text
COMPONENT   CURRENT       TARGET
kubelet     5 x v1.27.0   v1.27.16
~~~

The component configuration check also showed no manual config migration requirement:

~~~text
API GROUP                 CURRENT VERSION   PREFERRED VERSION   MANUAL UPGRADE REQUIRED
kubeproxy.config.k8s.io   v1alpha1          v1alpha1            no
kubelet.config.k8s.io     v1beta1           v1beta1             no
~~~

The plan exited with code <code>0</code>.

I also ran a dry run before the real change:

~~~bash
kubeadm upgrade apply v1.27.16 --dry-run
~~~

The dry run completed successfully.

For a multi-hop upgrade, I want both of these artifacts for every checkpoint:

~~~text
upgrade plan
dry run
~~~

That makes it much easier to separate "what kubeadm said it would do" from "what actually happened".

## Apply the control-plane upgrade

The real control-plane step was:

~~~bash
kubeadm upgrade apply v1.27.16 --yes
~~~

The command completed successfully.

During the apply, kubeadm upgraded the static-Pod control plane and etcd. It also renewed control-plane certificates.

The important component changes were:

~~~text
kube-apiserver             v1.27.0  → v1.27.16
kube-controller-manager    v1.27.0  → v1.27.16
kube-scheduler             v1.27.0  → v1.27.16
kube-proxy                 v1.27.0  → v1.27.16
etcd                       3.5.7-0  → 3.5.12-0
CoreDNS                    v1.10.1  → v1.10.1
~~~

kubeadm also created a backup of the previous static Pod manifests under <code>/etc/kubernetes/tmp/</code>.

### The certificate lifetime changed too

Before the upgrade, the non-CA Kubernetes certificates had roughly 102 days remaining.

After <code>kubeadm upgrade apply</code>, they had roughly 364 days remaining.

That was not a manual certificate operation. It happened as part of the kubeadm upgrade.

This is a good example of why I prefer recording certificate state both before and after a control-plane change instead of assuming "a patch upgrade only changes binaries".

## Why did kubectl get nodes still show v1.27.0?

Immediately after the control-plane upgrade, this can look confusing.

The API server and other control-plane components were already on <code>v1.27.16</code>, but:

~~~bash
kubectl get nodes
~~~

still showed the nodes as <code>v1.27.0</code>.

That is expected.

The <code>VERSION</code> column in <code>kubectl get nodes</code> reports the **kubelet version**, not the kube-apiserver version. We had not upgraded any kubelet yet.

So at this stage the real state was approximately:

~~~text
control-plane static Pods: v1.27.16
etcd:                      3.5.12
kubelets:                  v1.27.0
~~~

This distinction is worth checking before declaring a control-plane upgrade "failed" based only on the node version column.

## Wait for kube-proxy to finish rolling out

Right after the control-plane apply, kube-proxy was in a real transitional state: some Pods already used the <code>v1.27.16</code> image while others were still on <code>v1.27.0</code>.

I waited for the DaemonSet rollout instead of treating that intermediate snapshot as an error:

~~~bash
kubectl -n kube-system rollout status ds/kube-proxy --timeout=180s
~~~

Only after all kube-proxy Pods were Ready on the target image did I continue to kubelet upgrades.

This is another reason the raw logs are useful: a snapshot taken in the middle of a rollout can look unhealthy even when the rollout is behaving normally.

## Upgrade the control-plane kubelet and kubectl

The target kubelet and kubectl binaries were downloaded and checksum-verified in the same way as kubeadm.

Then I drained the control-plane node:

~~~bash
kubectl drain master --ignore-daemonsets
~~~

The drain succeeded.

After replacing <code>/usr/local/bin/kubelet</code> and <code>/usr/local/bin/kubectl</code>, I restarted kubelet:

~~~bash
systemctl daemon-reload
systemctl restart kubelet
~~~

The node came back as:

~~~text
master   Ready,SchedulingDisabled   ...   v1.27.16
~~~

The API readiness check still passed, so I uncordoned it:

~~~bash
kubectl uncordon master
~~~

At that point the control plane was fully on <code>v1.27.16</code>, while all four workers still reported <code>v1.27.0</code>.

## Upgrade workers one at a time

For each worker I used the same high-level sequence:

~~~text
copy verified binaries
↓
back up existing binaries and kubelet config
↓
replace kubeadm and kubectl
↓
kubeadm upgrade node
↓
drain
↓
replace kubelet
↓
restart kubelet
↓
verify Ready,SchedulingDisabled + target version
↓
uncordon
↓
verify again
~~~

Running:

~~~bash
kubeadm upgrade node
~~~

on the worker before replacing kubelet kept that node's kubelet configuration in sync with the cluster upgrade.

The first worker, however, showed why a real upgrade log is more useful than a perfect command list.

## Drain failure #1: emptyDir data

The first drain attempt on <code>node1</code> failed:

~~~text
cannot delete Pods with local storage
(use --delete-emptydir-data to override):
  kube-system/metrics-server-...
  kubernetes-dashboard/kubernetes-dashboard-...
  monitoring/prometheus-adapter-...

drain exit code: 1
~~~

The node was already cordoned, but the drain did not complete.

I did not immediately add every override flag. First I inspected the workloads and confirmed that these were controller-managed Pods and that the blocked local volumes were <code>emptyDir</code> data that could be recreated in this test cluster.

Then the retry used:

~~~bash
kubectl drain node1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=5m
~~~

That exposed the next blocker.

## Drain failure #2: a PodDisruptionBudget that allowed zero disruptions

<code>prometheus-adapter</code> had one replica and this PDB:

~~~text
MIN AVAILABLE          1
CURRENT                1
DESIRED                1
ALLOWED DISRUPTIONS    0
~~~

That combination does exactly what it says: eviction of the only healthy replica would violate the PDB.

Instead of bypassing the Eviction API, I temporarily scaled the Deployment to two replicas and waited for both to become Ready. With two healthy replicas, the PDB allowed one disruption and the drain could complete.

After <code>node1</code> was upgraded and uncordoned, I restored <code>prometheus-adapter</code> to its original single replica.

The important point is not "always scale to two". The important point is:

> Read the PDB and workload topology before deciding how to make a voluntary disruption safe.

For another application, changing replicas may be the wrong answer.

## The same drain blocker followed us to node3 and node4

Worker maintenance is not isolated.

After a Pod is evicted from one node, its controller schedules a replacement somewhere else. In this cluster, some of the same single-replica workloads moved onto nodes that had not been upgraded yet.

That meant later drains on <code>node3</code> and <code>node4</code> encountered the same kind of <code>emptyDir</code> blocker again.

This was a useful operational lesson:

> When upgrading workers sequentially, keep watching where singleton and stateful workloads are being rescheduled. A blocker can move with the workload.

After the relevant Pods had moved away and each node contained only expected DaemonSet Pods such as Calico, kube-proxy, and node-exporter, I upgraded the kubelet and uncordoned the node.

## node2 exposed a more serious Prometheus storage problem

I deliberately left <code>node2</code> for last because it hosted:

~~~text
prometheus-k8s-0
~~~

The Prometheus PDB showed:

~~~text
MIN AVAILABLE          1
ALLOWED DISRUPTIONS    0
~~~

The StatefulSet had one replica.

Before changing the PDB, I checked storage.

The result was more important than the upgrade itself:

~~~text
No PVCs in namespace monitoring
No StorageClasses
No PVs
~~~

And the Prometheus Pod showed:

~~~text
prometheus-k8s-db => emptyDir={}
~~~

So this Prometheus instance had been running for months, but its TSDB was not on persistent storage.

A container restart does not automatically delete an existing Pod's <code>emptyDir</code>, but deleting or evicting the Pod does. Draining the node would therefore discard the existing Prometheus history.

For this disposable test cluster, that data loss was acceptable and explicitly understood before proceeding. In a production environment, I would stop here and fix Prometheus persistence before continuing the maintenance.

To make the voluntary disruption possible, I first saved the original PDB YAML and then temporarily changed:

~~~text
minAvailable: 1
~~~

to:

~~~text
minAvailable: 0
~~~

After the PDB reported that one disruption was allowed, I drained <code>node2</code> with <code>--delete-emptydir-data</code>, upgraded its kubelet, uncordoned it, waited for Prometheus to become Ready again, and restored the original PDB behavior.

Prometheus came back as a fresh Pod on another worker.

That incident turned the upgrade into a useful storage audit: the cluster upgrade did not create the Prometheus persistence problem, but the maintenance procedure exposed it.

## Final v1.27.16 verification

After the final worker upgrade, all five nodes were on the same patch:

~~~text
NAME     STATUS   ROLES           VERSION
master   Ready    control-plane   v1.27.16
node1    Ready    worker          v1.27.16
node2    Ready    worker          v1.27.16
node3    Ready    worker          v1.27.16
node4    Ready    worker          v1.27.16
~~~

The client and server versions also matched:

~~~text
kubeadm:            v1.27.16
kubelet:            v1.27.16
kubectl client:     v1.27.16
Kubernetes server:  v1.27.16
~~~

The final kube-system check showed all system Pods Running.

The verbose API readiness check passed, including etcd readiness:

~~~text
[+]ping ok
[+]etcd ok
[+]etcd-readiness ok
...
readyz check passed
~~~

<code>kubectl top nodes</code> also returned metrics for all five nodes.

At the final checkpoint, Prometheus had been recreated and was <code>2/2 Running</code>, and its PDB had been restored to <code>minAvailable: 1</code>.

## What changed in this first checkpoint?

The first step of the long migration ended with:

| Item | Before | After |
| --- | --- | --- |
| Kubernetes control plane | v1.27.0 | v1.27.16 |
| kubelet on 5 nodes | v1.27.0 | v1.27.16 |
| kube-proxy | v1.27.0 | v1.27.16 |
| etcd | 3.5.7-0 | 3.5.12-0 |
| CoreDNS | v1.10.1 | v1.10.1 |
| non-CA cert lifetime | ~102 days remaining | ~364 days remaining |
| node health | all Ready | all Ready |
| API readiness | passed | passed |

And, just as importantly, the maintenance exposed three operational risks:

1. <code>emptyDir</code> workloads can block <code>kubectl drain</code>.
2. A single replica protected by <code>minAvailable: 1</code> can make a voluntary eviction impossible.
3. A stateful-looking workload can still be using ephemeral storage; check the actual volume source before draining it.

## FAQ

### Is Kubernetes v1.27.16 still supported?

No. Kubernetes 1.27 reached end of life on July 16, 2024. <code>v1.27.16</code> is the final patch in that series, not a currently supported release. This checkpoint exists only because the starting cluster was still on <code>v1.27.0</code> and the goal is to move forward through each minor version safely.

### Was v1.27.16 mandatory before moving to v1.28?

Not strictly. The key kubeadm rule is that skipping minor versions is unsupported. I chose the final <code>1.27</code> patch as a conservative checkpoint before crossing into <code>1.28</code>, and Kubernetes recommends staying on the latest patch release available for a minor version.

### Why did kubectl get nodes show v1.27.0 after the control plane was already upgraded?

Because the <code>VERSION</code> column reports kubelet version. The control-plane static Pods had already moved to <code>v1.27.16</code>, but the kubelets were still on <code>v1.27.0</code> until they were upgraded separately.

### Why did kubectl drain keep failing?

Two independent safeguards appeared. First, some Pods used <code>emptyDir</code>, so drain required an explicit decision about deleting local ephemeral data. Second, a single-replica workload had a PodDisruptionBudget with <code>minAvailable: 1</code>, leaving zero allowed voluntary disruptions.

## Next checkpoint

The cluster is now consistently on <code>v1.27.16</code>.

The next step in this same migration is:

~~~text
v1.27.16
  ↓
v1.28.15
~~~

Before that jump, I will create a fresh recovery checkpoint and review version-specific changes for Kubernetes 1.28 instead of assuming the exact same behavior will repeat.

This article will continue to grow from the actual upgrade logs rather than from a reconstructed happy-path procedure.

## References

- <a href="https://kubernetes.io/releases/1.27/" target="_blank" rel="noopener noreferrer">Kubernetes 1.27 release status</a>
- <a href="https://kubernetes.io/releases/patch-releases/" target="_blank" rel="noopener noreferrer">Kubernetes patch releases</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/" target="_blank" rel="noopener noreferrer">Upgrading kubeadm clusters</a>
- <a href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/upgrading-linux-nodes/" target="_blank" rel="noopener noreferrer">Upgrading Linux nodes</a>
- <a href="https://kubernetes.io/releases/version-skew-policy/" target="_blank" rel="noopener noreferrer">Kubernetes version skew policy</a>
- <a href="https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/" target="_blank" rel="noopener noreferrer">kubectl drain reference</a>
- <a href="https://kubernetes.io/docs/concepts/workloads/pods/disruptions/" target="_blank" rel="noopener noreferrer">Pod disruption budgets and voluntary disruptions</a>
