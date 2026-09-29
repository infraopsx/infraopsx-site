---
layout: ../../../../layouts/ArticleLayout.astro
title: "Rook Ceph OSD 内存占用过高：osd_memory_target 与资源限制排查"
description: "一次真实的 Rook Ceph OSD 内存排障记录：16 GiB 节点上的单个 ceph-osd RSS 达到 11 GiB，通过 osd_memory_target 与 Kubernetes resources 定位问题，并验证资源限制后的变化。"
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

这篇文章来自一份 2022 年 6 月的现场记录。

当时几台 Rook Ceph 节点都只有 16 GiB 左右内存，但单个 `ceph-osd` 进程的常驻内存已经跑到 11 GiB。节点上还需要运行其他进程，这种占用显然不能直接忽略。

最终排查到两个很重要的现象：

- OSD Pod 没有配置 Kubernetes `requests / limits`；
- 当时环境里的 `osd_memory_target` 达到了约 13.3 GB。

给 OSD 增加 CPU / Memory 资源配置后，Pod 的资源限制开始生效，同时观察到 `osd_memory_target` 也发生了变化。

> 这是一份旧版本环境的真实排障记录，不是当前所有 Rook / Ceph 版本的固定行为说明。当前 Ceph 仍将 `osd_memory_target` 定义为 best-effort memory target，而当前 Rook 文档对 OSD memory resource 与 `osd_memory_target` 的处理已经与这份旧记录中的实测结果不同。生产环境调整前，请先确认自己的 Ceph、Rook 版本和实际负载。

## 1. 先看 OSD 到底用了多少内存

最开始是在节点上通过 `top` 发现异常：

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

节点总内存大约 16 GiB，而这个 OSD 的 `RES` 已经达到：

~~~text
11.0g
~~~

也就是单个 OSD 实际占掉了节点约 70% 的内存。

接着进入 Rook toolbox 看 OSD 分布：

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

三个节点，每个节点一个 HDD OSD。

这种规模下，一个 OSD 占用 11 GiB 内存已经足够影响节点上其他工作负载。

## 2. 检查 osd_memory_target

继续查看三个 OSD 的 `osd_memory_target`：

~~~shell
# ceph tell osd.0 config show | grep -w osd_memory_target
   "osd_memory_target": "13344836812",

# ceph tell osd.1 config show | grep -w osd_memory_target
   "osd_memory_target": "13344836812",

# ceph tell osd.2 config show | grep -w osd_memory_target
   "osd_memory_target": "13344836812",
~~~

三个 OSD 都是：

~~~text
13344836812 bytes
~~~

也就是 12 GiB 以上的 memory target。

这与前面看到的：

~~~text
VIRT  12.7g
RES   11.0g
~~~

至少在方向上是吻合的。

不过这里有一个很容易误解的地方：

> `osd_memory_target` 不是一个严格的进程 RSS 上限。

Ceph 的 BlueStore cache autotune 会尝试围绕这个 target 调整内存，但它是 best-effort 机制。内核是否及时回收内存、TCMalloc 行为以及其他 OSD 内存开销都会影响最终 RSS。

所以不能简单理解成：

~~~text
osd_memory_target = ceph-osd 最大 RSS
~~~

这里只能确定：当时 OSD 被配置了一个非常高的 memory target。

下一步还要确认 Kubernetes 有没有限制 OSD Pod。

## 3. 检查 OSD Pod 的 resources

查看其中一个 OSD Pod：

~~~shell
# kubectl -n rook-ceph get pods rook-ceph-osd-0-7c76474f7-tnhc6 -ojson | jq .spec.containers[].resources
{}
~~~

结果非常直接：

~~~json
{}
~~~

没有 request，也没有 limit。

于是当时的现场可以整理成：

~~~text
节点内存约 16 GiB
        ↓
OSD Pod 没有 Kubernetes memory limit
        ↓
osd_memory_target 约 13.3 GB
        ↓
ceph-osd RSS 达到 11 GiB
~~~

这些证据足以说明资源配置值得调整，但不能仅凭这几项就断言存在或不存在内存泄漏。

## 4. 给 OSD 配置 CPU 和内存资源

当时这套小集群还要承载其他进程，所以决定先给每个 OSD 配置：

~~~text
CPU:    2
Memory: 4 GiB
~~~

直接编辑 CephCluster：

~~~shell
## 编辑 CR，添加资源限制（会自动重新配置 osd）
# kubectl -n rook-ceph edit cephclusters.ceph.rook.io rook-ceph
~~~

当时使用的节点级资源配置如下：

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

保存 CephCluster 后，Rook 会根据 CR 变化重新配置相关 OSD。

这里的 2 CPU / 4 GiB 是当时这套环境根据节点资源做出的取舍，并不是所有 Ceph 集群都应该照抄。

尤其是内存不能一味往低了压。BlueStore 需要内存做缓存，memory target 太低可能增加 metadata / RocksDB 读取压力，最终影响 I/O 性能。

## 5. 确认新的 Kubernetes 资源限制

OSD 重新创建后，再看 Pod resources：

~~~shell
# kubectl -n rook-ceph get pods rook-ceph-osd-0-6ff54bb9c7-vbk59 -ojson | jq .spec.containers[].resources
~~~

输出：

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

这一次，OSD container 的资源配置已经生效。

## 6. 再看 ceph-osd 的实际内存

回到节点上继续观察：

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

刚重新启动后的 OSD：

~~~text
RES 455712 KiB
~~~

相比之前的：

~~~text
RES 11.0g
~~~

看上去已经低了很多。

但这里不能把这个数字当成最终稳定内存占用。

因为从：

~~~text
TIME+  0:11.17
~~~

可以看出，这个 OSD 才刚启动十几秒。

BlueStore cache 会随着运行逐渐变化。更有意义的是继续观察正常业务运行一段时间后的稳定 RSS，同时留意：

~~~text
OOMKilled
node memory pressure
OSD restart
I/O latency 上升
BlueStore / RocksDB 性能下降
~~~

因此，这一条输出只能证明“刚重建后的 OSD 内存明显下降”，不能证明以后会永久维持在 455 MiB。

## 7. osd_memory_target 也发生了变化

再次进入 toolbox：

~~~shell
# kubectl -n rook-ceph exec -it rook-ceph-tools-6ccb958485-j7pvb -- bash
# ceph tell osd.0 config show | grep -w osd_memory_target
   "osd_memory_target": "3435973836",
~~~

当时这个版本最终观察到：

~~~text
3435973836 bytes
~~~

大约 3.2 GiB。

也就是说，在这套旧环境中设置：

~~~yaml
memory: "4096Mi"
~~~

之后，最终看到的 `osd_memory_target` 大约是 3.2 GiB。

这个结果值得保留，因为它就是当时真实发生的事情；但它同样不能被写成一个今天仍然通用的公式。

当前 Rook 文档说明，当声明 OSD memory resource 时，Rook 会自动设置对应的 `osd_memory_target`。当前 Ceph 文档则说明 `osd_memory_target` 默认值为 4 GiB，并强调实际 RSS 可能高于或低于 target。

因此：

> 不要把“4 GiB resource limit 一定得到 3.2 GiB osd_memory_target”当成当前 Rook / Ceph 的固定行为。

如果今天重新遇到同样的问题，我还是会先看这三处。

检查进程实际内存：

~~~shell
top -p $(pidof ceph-osd)
~~~

检查 Ceph 当前 target：

~~~shell
ceph tell osd.<id> config show | grep -w osd_memory_target
~~~

检查 Kubernetes resources：

~~~shell
kubectl -n rook-ceph get pod <osd-pod> -ojson | jq .spec.containers[].resources
~~~

然后再判断问题属于哪一类：

~~~text
OSD 正常使用了一个很大的 memory target
        │
        ├── Kubernetes resources 没有限制
        │
        ├── resource / target 配置不适合当前节点
        │
        └── 或者确实存在异常内存增长，需要继续排查
~~~

## 8. 这次排查真正值得留下的几个点

这次问题本身并不复杂，但有几个经验到现在仍然有用。

第一，不要只看到 `ceph-osd RES` 很高就直接判断内存泄漏。

先看：

~~~text
osd_memory_target
Kubernetes requests / limits
BlueStore cache 配置
实际 OSD 负载
~~~

第二，`osd_memory_target` 是 target，不是 RSS hard limit。

第三，容器里的 Ceph OSD 还要同时考虑 Kubernetes memory limit。如果 target 和容器限制配置得不合理，最终可能表现为节点内存紧张、Pod OOM 或存储性能下降。

第四，修改完资源后不要只看 OSD 刚启动几秒时的内存。至少在正常业务下持续观察一段时间，再判断新的配置是否合适。

## 参考

- [OSD and MON memory consumption — rook/rook#5811](https://github.com/rook/rook/issues/5811)
- [Ceph OSD Pod memory consumption very high — rook/rook#5821](https://github.com/rook/rook/issues/5821)
- [Rook CephCluster CRD](https://rook.io/docs/rook/latest/CRDs/Cluster/ceph-cluster-crd/)
- [Ceph BlueStore Configuration Reference](https://docs.ceph.com/en/latest/rados/configuration/bluestore-config-ref/)
- [Ceph Hardware Recommendations](https://docs.ceph.com/en/latest/start/hardware-recommendations/)

## 相关阅读

如果你正在继续排查 Ceph / Kubernetes 存储问题：

- [Kubernetes iowait 很高但吞吐不高：Ceph RBD 与 OSD 延迟排查](/zh/blog/kubernetes-ceph-rbd-high-iowait-latency/)
- [CephFS HEALTH_WARN：MDS_CLIENT_LATE_RELEASE 与 MDS_SLOW_REQUEST 排查](/zh/blog/cephfs-client-late-release-mds-slow-request/)
- [Kubernetes + Rook Ceph：排查 “RBD image is still being used” FailedMount](/zh/blog/rook-ceph-rbd-image-still-being-used-failedmount/)
