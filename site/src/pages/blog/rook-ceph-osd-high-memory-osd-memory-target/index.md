---
layout: ../../../layouts/ArticleLayout.astro
title: "Rook Ceph OSD High Memory Usage: osd_memory_target and Resource Limits"
description: "A real Rook Ceph OSD memory troubleshooting record: one ceph-osd reached 11 GiB RSS on a 16 GiB node, leading to checks of osd_memory_target, Kubernetes resources, and the effect of adding OSD limits."
pubDate: "2026-09-29"
category: Storage
tags:
  - Ceph
  - Rook
  - OSD
  - Kubernetes
  - BlueStore
  - Troubleshooting
enPath: "/blog/rook-ceph-osd-high-memory-osd-memory-target/"
zhPath: "/zh/blog/rook-ceph-osd-high-memory-osd-memory-target/"
---

This article is based on a real incident recorded in June 2022.

The Rook Ceph nodes had roughly 16 GiB of RAM each, but a single `ceph-osd` process had reached about 11 GiB of resident memory. These nodes were not dedicated to Ceph, so that level of memory consumption left very little room for anything else.

Two details stood out during the investigation:

- the OSD Pod had no Kubernetes `requests / limits`;
- `osd_memory_target` was around 13.3 GB in that environment.

After adding CPU and memory resources to the OSDs, the Pod limits took effect and the observed `osd_memory_target` changed as well.

> This is a historical troubleshooting record from an older Rook/Ceph environment, not a description of fixed behavior across current versions. Ceph still treats `osd_memory_target` as a best-effort target, while current Rook documentation describes resource-to-target behavior differently from the value observed in this old incident. Check your own Ceph and Rook versions before applying the same numbers.

## 1. Confirm how much memory the OSD is actually using

The issue first became obvious on the node:

~~~shell
# top -p $(pidof ceph-osd)
top - 11:30:08 up 26 days, 16:38,  3 users,  load average: 0.74, 0.57, 0.72
Tasks:   1 total,   0 running,   1 sleeping,   0 stopped,   0 zombie
%Cpu(s):  2.5 us,  1.6 sy,  0.0 ni, 94.1 id,  1.3 wa,  0.0 hi,  0.5 si,  0.0 st
MiB Mem : 91.5/16008.3  [||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||        ]
MiB Swap:  0.0/0.0      [                                                                                                    ]

   PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
  5831 167       20   0   12.7g  11.0g   7720 S   2.7  70.5 617:42.90 ceph-osd
~~~

The node had about 16 GiB of RAM, while this OSD alone showed:

~~~text
RES 11.0g
~~~

That is roughly 70% of the node's memory.

I then entered the Rook toolbox and checked the OSD layout:

~~~shell
# kubectl -n rook-ceph exec -it rook-ceph-tools-6ccb958485-j7pvb -- bash
# ceph osd tree
ID  CLASS  WEIGHT   TYPE NAME       STATUS  REWEIGHT  PRI-AFF
-1         3.00000  root default
-3         1.00000      host node1
 1    hdd  1.00000          osd.1       up   1.00000  1.00000
-7         1.00000      host node2
 2    hdd  1.00000          osd.2       up   1.00000  1.00000
-5         1.00000      host node3
 0    hdd  1.00000          osd.0       up   1.00000  1.00000
~~~

There were three nodes with one HDD OSD on each node.

On this small shared cluster, 11 GiB of resident memory for a single OSD was enough to justify a closer look.

## 2. Check osd_memory_target

The next step was to inspect `osd_memory_target`:

~~~shell
# ceph tell osd.0 config show | grep -w osd_memory_target
   "osd_memory_target": "13344836812",

# ceph tell osd.1 config show | grep -w osd_memory_target
   "osd_memory_target": "13344836812",

# ceph tell osd.2 config show | grep -w osd_memory_target
   "osd_memory_target": "13344836812",
~~~

All three OSDs had the same value:

~~~text
13344836812 bytes
~~~

That is more than 12 GiB.

It lines up directionally with the earlier process numbers:

~~~text
VIRT  12.7g
RES   11.0g
~~~

But there is an important distinction:

> `osd_memory_target` is not a hard RSS limit.

With BlueStore cache autotuning enabled, Ceph tries to keep memory around the configured target. The result is best effort. Kernel reclaim behavior, allocator behavior, and memory outside the cache can all make the process RSS differ from the target.

So this should not be read as:

~~~text
osd_memory_target = maximum ceph-osd RSS
~~~

What the output did prove was that these OSDs had a very large target for 16 GiB shared nodes.

The next question was whether Kubernetes imposed any memory limit on the Pod itself.

## 3. Check the OSD Pod resources

For one OSD Pod:

~~~shell
# kubectl -n rook-ceph get pods rook-ceph-osd-0-7c76474f7-tnhc6 -ojson | jq .spec.containers[].resources
{}
~~~

The result was simply:

~~~json
{}
~~~

No request and no limit.

The incident therefore looked like this:

~~~text
Node RAM ≈ 16 GiB
        ↓
OSD Pod has no Kubernetes memory limit
        ↓
osd_memory_target ≈ 13.3 GB
        ↓
ceph-osd RSS reaches 11 GiB
~~~

That was enough evidence to revisit the resource configuration, but not enough to prove or disprove a memory leak.

## 4. Add CPU and memory resources to the OSDs

These nodes also ran other workloads, so the decision at the time was to allocate:

~~~text
CPU:    2
Memory: 4 GiB
~~~

The CephCluster was edited directly:

~~~shell
## Edit the CR and add OSD resources
# kubectl -n rook-ceph edit cephclusters.ceph.rook.io rook-ceph
~~~

The node-specific configuration used at the time was:

~~~yaml
storage:
  nodes:
  - devices:
    - name: sdb
    name: node1
    resources:
      limits:
        cpu: "2"
        memory: "4096Mi"
      requests:
        cpu: "2"
        memory: "4096Mi"

  - devices:
    - name: sdb
    name: node2
    resources:
      limits:
        cpu: "2"
        memory: "4096Mi"
      requests:
        cpu: "2"
        memory: "4096Mi"

  - devices:
    - name: sdb
    name: node3
    resources:
      limits:
        cpu: "2"
        memory: "4096Mi"
      requests:
        cpu: "2"
        memory: "4096Mi"
~~~

Rook then reconciled the OSD configuration from the updated CephCluster.

The 2 CPU / 4 GiB values were a trade-off for this small environment. They are not universal sizing recommendations.

Reducing OSD memory too aggressively can hurt performance. BlueStore uses memory for caching, and an undersized target can increase metadata or RocksDB reads from storage.

## 5. Verify the Kubernetes resources

After the OSD was recreated, the resources looked like this:

~~~shell
# kubectl -n rook-ceph get pods rook-ceph-osd-0-6ff54bb9c7-vbk59 -ojson | jq .spec.containers[].resources
~~~

~~~json
{
  "limits": {
    "cpu": "2",
    "memory": "4Gi"
  },
  "requests": {
    "cpu": "2",
    "memory": "4Gi"
  }
}
~~~

The OSD container now had the intended resource configuration.

## 6. Check ceph-osd memory again

Back on the node:

~~~shell
# top -p $(pidof ceph-osd)
top - 11:50:13 up 26 days, 16:58,  3 users,  load average: 0.71, 0.97, 0.89
Tasks:   1 total,   0 running,   1 sleeping,   0 stopped,   0 zombie
%Cpu(s):  2.7 us,  1.1 sy,  0.0 ni, 96.0 id,  0.1 wa,  0.0 hi,  0.1 si,  0.0 st
MiB Mem : 23.6/16008.3  [||||||||||||||||||||||||]
MiB Swap:  0.0/0.[]

   PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
2172679 167       20   0 1462020 455712  33268 S   2.3   2.8   0:11.17 ceph-osd
~~~

Immediately after restart, the OSD showed:

~~~text
RES 455712 KiB
~~~

That was dramatically lower than the previous:

~~~text
RES 11.0g
~~~

But this is not a fair steady-state comparison.

The process had only accumulated:

~~~text
TIME+  0:11.17
~~~

so it had been running for only a short time.

BlueStore cache usage grows and changes with workload. The useful follow-up is to observe the OSD under normal traffic and check for:

~~~text
OOMKilled
node memory pressure
OSD restarts
higher I/O latency
BlueStore / RocksDB performance regressions
~~~

This output proves that memory was low immediately after the OSD restart. It does not prove that the process would remain at 455 MiB.

## 7. osd_memory_target changed as well

After re-entering the toolbox:

~~~shell
# kubectl -n rook-ceph exec -it rook-ceph-tools-6ccb958485-j7pvb -- bash
# ceph tell osd.0 config show | grep -w osd_memory_target
   "osd_memory_target": "3435973836",
~~~

The observed value in this old environment was:

~~~text
3435973836 bytes
~~~

roughly 3.2 GiB.

So after configuring:

~~~yaml
memory: "4096Mi"
~~~

this particular Rook/Ceph version ended up with an observed `osd_memory_target` of about 3.2 GiB.

That result is worth preserving because it is what actually happened in the incident. It should not, however, be treated as a current formula.

Current Rook documentation states that declaring memory resources for OSDs causes Rook to set `osd_memory_target` accordingly. Current Ceph documentation lists 4 GiB as the default target and explicitly notes that RSS does not have to match the target exactly.

Therefore:

> Do not assume that a 4 GiB memory resource always produces a 3.2 GiB `osd_memory_target` on current Rook/Ceph releases.

If the same symptom appeared today, I would still start with these three checks.

Process memory:

~~~shell
top -p $(pidof ceph-osd)
~~~

Ceph target:

~~~shell
ceph tell osd.<id> config show | grep -w osd_memory_target
~~~

Kubernetes resources:

~~~shell
kubectl -n rook-ceph get pod <osd-pod> -ojson | jq .spec.containers[].resources
~~~

Then determine whether the issue is:

~~~text
a legitimately large OSD memory target
        │
        ├── missing Kubernetes resources
        ├── a target/resource setting that does not fit the node
        └── or abnormal memory growth that needs deeper investigation
~~~

## 8. What is still useful from this old incident

The exact version behavior may have changed, but several troubleshooting lessons still hold.

First, high `ceph-osd RES` by itself is not enough to call something a memory leak.

Check:

~~~text
osd_memory_target
Kubernetes requests / limits
BlueStore cache settings
actual OSD workload
~~~

Second, `osd_memory_target` is a target, not a hard RSS ceiling.

Third, containerized OSDs need both Ceph memory behavior and Kubernetes memory limits to be considered together. Badly chosen values can show up as node memory pressure, Pod OOMs, or degraded storage performance.

Finally, do not judge the new configuration only from memory usage a few seconds after an OSD restart. Observe it under normal workload long enough to see a stable pattern.

## References

- [OSD and MON memory consumption — rook/rook#5811](https://github.com/rook/rook/issues/5811)
- [Ceph OSD Pod memory consumption very high — rook/rook#5821](https://github.com/rook/rook/issues/5821)
- [Rook CephCluster CRD](https://rook.io/docs/rook/latest/CRDs/Cluster/ceph-cluster-crd/)
- [Ceph BlueStore Configuration Reference](https://docs.ceph.com/en/latest/rados/configuration/bluestore-config-ref/)
- [Ceph Hardware Recommendations](https://docs.ceph.com/en/latest/start/hardware-recommendations/)

## Related reading

For more Kubernetes and Ceph storage troubleshooting:

- [Kubernetes iowait is high but throughput is low: tracing Ceph RBD and OSD latency](/blog/kubernetes-ceph-rbd-high-iowait-latency/)
- [CephFS HEALTH_WARN: troubleshooting MDS_CLIENT_LATE_RELEASE and MDS_SLOW_REQUEST](/blog/cephfs-client-late-release-mds-slow-request/)
- [Kubernetes + Rook Ceph: troubleshooting “RBD image is still being used” FailedMount](/blog/rook-ceph-rbd-image-still-being-used-failedmount/)
