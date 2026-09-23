---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes iowait 很高但吞吐不高：Ceph RBD 与 OSD 延迟排查"
description: "一次真实的 Kubernetes + Ceph RBD 性能排障记录：从高 iowait、D 状态线程和 rbd4 入手，通过 iostat、PV/PVC 映射、Ceph OSD latency 与 BlueStore slow ops，将问题定位到 Ceph OSD 后端存储链路。"
pubDate: "2026-09-23"
category: Storage
tags:
  - Kubernetes
  - Prometheus
  - Ceph
  - RBD
  - iostat
  - BlueStore
  - Performance
  - Troubleshooting
enPath: "/blog/kubernetes-ceph-rbd-high-iowait-latency/"
zhPath: "/zh/blog/kubernetes-ceph-rbd-high-iowait-latency/"
---

在 Kubernetes 节点 `node3-192-168-201-103` 上查看 `atop` 时，CPU 的 I/O wait 明显偏高。

<figure style="margin:1.5rem auto;text-align:center;">
  <a
    href="/images/articles/kubernetes-ceph-rbd-high-iowait-latency/atop-high-iowait.png"
    target="_blank"
    rel="noopener"
  >
    <img
      src="/images/articles/kubernetes-ceph-rbd-high-iowait-latency/atop-high-iowait.png"
      alt="atop 显示 Kubernetes 节点 I/O wait 偏高"
      style="display:block;width:100%;max-width:760px;height:auto;margin:0 auto;cursor:zoom-in;"
      loading="lazy"
    />
  </a>
  <figcaption style="margin-top:.5rem;font-size:.9rem;opacity:.75;">
    当时的 atop 现场截图。
  </figcaption>
</figure>

截图中的关键现象是：

```text
8 CPU
wait 203%

sda:
busy  ≈ 51%
read  ≈ 2.1 MB/s
write ≈ 0.1 MB/s
avio  ≈ 2.67 ms
```

`atop` 的 CPU 百分比会按 CPU 累加显示，因此 8 个 CPU 下 `wait 203%` 大约相当于整体约 25% 的 CPU 时间在等待 I/O。

但同一画面里，本地 `sda` 并没有出现足以直接解释这种等待的高吞吐或高 `avio`。

所以接下来的问题很直接：

> **这些 CPU 到底在等哪个 I/O？**

---

## 1. atop 发现异常：CPU 在等 I/O，但 sda 解释不了

`atop` 提供了最初的矛盾：

```text
CPU I/O wait 很高
```

同时：

```text
sda 吞吐不高
avio 只有约 2.67 ms
```

这意味着不能直接把问题归结为本地 `sda` 被打满。

接下来需要用更直接的系统指标确认两件事：

1. 高 I/O wait 是否持续存在；
2. 是否有任务已经进入不可中断睡眠。

---

## 2. 用 mpstat 和 vmstat 交叉确认 I/O wait

先执行：

```bash
mpstat -P ALL 1 10
```

10 秒平均值中：

```text
Average:     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle
Average:     all   18.01    0.00    9.79   30.43    0.00    1.31    0.05    0.00    0.00   40.40
```

也就是说，采样期间平均约 30% 的 CPU 时间处于 I/O wait。

随后执行：

```bash
vmstat 1 10
```

原始 10 次采样如下：

```text
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 3  6      0 1278408 316324 2026816    0    0    29    70    1    1 17 10 71  3  0
 1  4      0 1277048 316336 2027008    0    0    64   116 8888 13794 22 10 39 29  0
 3  2      0 1293424 316372 2027020    0    0     0   492 9743 14968 22 11 41 27  0
 1  0      0 1292404 316392 2027208    0    0   120   340 10357 15448 22 12 55 10  0
 1  1      0 1295052 316440 2027296    0    0     0   660 10889 16226 23 10 58  8  0
 2  3      0 1286144 316452 2027520    0    0     0   144 11604 18660 26 11 42 21  0
 3  6      0 1241248 316468 2027660    0    0   100   180 8355 12296 29  9 32 30  0
 2 10      0 1172868 316476 2027712    0    0     0    96 10166 15778 26 11 29 34  0
 1  9      0 1165500 316488 2028132    0    0   396   244 11219 15918 15 12 20 53  0
 1  3      0 1137228 316512 2028320    0    0   544   240 10382 15253 16 12 39 33  0
```

这里重点看两列：

```text
b
wa
```

其中：

```text
b 最高达到 10
wa 最高达到 53%
```

`b` 表示处于不可中断睡眠、通常正在等待 I/O 的任务数。

到这里可以确认：

> 高 iowait 不是 `atop` 的瞬时显示，系统确实有一批任务在等待 I/O。

但还不知道它们究竟在等什么。

---

## 3. 查 D 状态线程：第一次把线索指向 rbd4

下一步执行：

```bash
ps -eLo pid,tid,stat,wchan:40,comm,args | awk '$3 ~ /^D/'
```

命令参数的含义：

```text
-e
显示所有进程。

-L
按线程展示，而不是只显示进程主线程。

-o
指定要输出的字段。

pid / tid
分别是进程 ID 和线程 ID。

stat
线程状态。以 D 开头表示 uninterruptible sleep，
常见于正在等待块设备或其他内核 I/O。

wchan:40
显示线程当前睡眠/等待的内核函数，宽度设为 40。

comm
命令名。

args
完整启动参数。

awk '$3 ~ /^D/'
只保留 stat 以 D 开头的记录，所以 D、Ds、Dsl、Dl 都会被匹配。
```

当时输出中包含：

```text
  13902   13902 Ds   wait_on_page_bit  postgres        postgres: gatorcloud-pg: logger
 188161  188185 Dsl  wait_on_page_bit  etcd            etcd ...
1807859 1807859 Ds   wait_on_page_bit  postgres        postgres: gatorcloud-pg: grafana grafana ... INSERT
2476335 2476335 D    wait_on_buffer    jbd2/rbd4-8     [jbd2/rbd4-8]
2934503 2935843 Dl   wait_on_page_bit  elasticsearch   /usr/share/elasticsearch/jdk/bin/java ...
```

真正改变排查方向的是：

```text
2476335 2476335 D wait_on_buffer jbd2/rbd4-8 [jbd2/rbd4-8]
```

`jbd2` 是 ext4 的 journaling 线程。

线程名里的：

```text
rbd4
```

说明它对应 `/dev/rbd4`。

也就是说，此时第一次拿到了比“CPU iowait 高”更具体的证据：

> **有 ext4 journaling 线程正因为 rbd4 的块 I/O 而处于 D 状态。**

所以下一步开始围绕 `rbd4` 查。

---

## 4. 通过 CSI RBD Plugin 确认 rbd4 对应的 RBD image

前面已经从 D 状态线程看到：

```text
2476335 2476335 D wait_on_buffer jbd2/rbd4-8 [jbd2/rbd4-8]
```

下一步就是确认 `/dev/rbd4` 在 Ceph 中对应哪个 RBD image。

节点本机没有安装 `rbd` CLI，因此通过运行在 node3 上的 CSI RBD Plugin 容器查询：

```bash
kubectl -n rook-ceph exec -it csi-rbdplugin-ktkvl \
  -c csi-rbdplugin -- rbd device list
```

输出：

```text
id  pool  namespace  image                                           snap  device
0   rbd              csi-vol-dd591ece-7af9-43fc-b55c-94e9da9f2e89  -     /dev/rbd0
1   rbd              csi-vol-b9798af4-a5d5-4c97-a22e-740862997874  -     /dev/rbd1
2   rbd              csi-vol-0efd576e-a960-4761-a3c9-354ce4203d68  -     /dev/rbd2
3   rbd              csi-vol-a08a64bb-01b3-4d7a-ac21-7a5b34a03bef  -     /dev/rbd3
4   rbd              csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd  -     /dev/rbd4
```

因此可以直接确认：

```text
/dev/rbd4
        ↓
rbd/csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
```

到这里仍然只知道它是一个由 CSI 管理的 Ceph RBD image。

还不知道它在 Kubernetes 中对应哪个 PV、PVC，以及最终被哪个 Pod 使用。

---

## 5. 从 RBD image 逐层找到 PV、PVC 和 Prometheus Pod

现在已知的线索只有：

```text
csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
```

首先从所有 PV 中按照 CSI 的 `imageName` 精确匹配：

```bash
kubectl get pv \
  -o jsonpath='{range .items[*]}{.metadata.name}{"	"}{.spec.csi.volumeAttributes.imageName}{"	"}{.spec.claimRef.namespace}{"/"}{.spec.claimRef.name}{"
"}{end}' \
  | grep 'csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd'
```

实际输出：

```text
pvc-802412b9-debe-4945-9204-867c3b60f25d    csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd    monitoring/data-prometheus-k8s-0
```

这一步已经把 RBD image 与 PV、PVC 对上：

```text
RBD image
csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
        ↓
PV
pvc-802412b9-debe-4945-9204-867c3b60f25d
        ↓
PVC
monitoring/data-prometheus-k8s-0
```

为了进一步验证，直接查看这个 PV：

```bash
kubectl get pv pvc-802412b9-debe-4945-9204-867c3b60f25d -o yaml
```

其中关键内容为：

```yaml
metadata:
  name: pvc-802412b9-debe-4945-9204-867c3b60f25d

spec:
  capacity:
    storage: 128Gi

  claimRef:
    kind: PersistentVolumeClaim
    name: data-prometheus-k8s-0
    namespace: monitoring

  csi:
    driver: rook-ceph.rbd.csi.ceph.com
    fsType: ext4

    volumeAttributes:
      clusterID: rook-ceph-external
      imageFeatures: layering
      imageFormat: "2"
      imageName: csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
      journalPool: rbd
      pool: rbd

    volumeHandle: 0001-0012-rook-ceph-external-0000000000000008-82a11e26-3406-4663-8f83-dee8b985e6dd

  storageClassName: ceph-rbd-external
  volumeMode: Filesystem

status:
  phase: Bound
```

此时，`rbd4 → RBD image → PV → PVC` 的映射已经完全确定：

```text
/dev/rbd4
        ↓
csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
        ↓
PV pvc-802412b9-debe-4945-9204-867c3b60f25d
        ↓
PVC monitoring/data-prometheus-k8s-0
```

接下来确认这个 PVC 被哪个 Pod 使用：

```bash
kubectl -n monitoring describe pvc data-prometheus-k8s-0
```

关键输出：

```text
Name:          data-prometheus-k8s-0
Namespace:     monitoring
StorageClass:  ceph-rbd-external
Status:        Bound
Volume:        pvc-802412b9-debe-4945-9204-867c3b60f25d
Capacity:      128Gi
Access Modes:  RWO
VolumeMode:    Filesystem
Used By:       prometheus-k8s-0
```

这里直接给出：

```text
Used By: prometheus-k8s-0
```

于是完整的业务映射变成：

```text
/dev/rbd4
        ↓
csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
        ↓
PV pvc-802412b9-debe-4945-9204-867c3b60f25d
        ↓
PVC monitoring/data-prometheus-k8s-0
        ↓
Pod prometheus-k8s-0
```

为了再验证一次 Pod 的 volume 配置：

```bash
kubectl -n monitoring get pod prometheus-k8s-0 \
  -o jsonpath='{range .spec.volumes[*]}{.name}{"	"}{.persistentVolumeClaim.claimName}{"
"}{end}'
```

输出：

```text
data    data-prometheus-k8s-0
config
tls-assets
config-out
prometheus-k8s-rulefiles-0
web-config
kube-api-access-k8pnb
```

第一行明确说明：

```text
Pod volume: data
        ↓
PVC: data-prometheus-k8s-0
```

由于整个排查一开始就在 `node3-192-168-201-103` 上进行，这里再看一次 Pod 调度位置，只是用于确认业务映射与最初现场一致：

```bash
kubectl -n monitoring get pod prometheus-k8s-0 -o wide
```

输出：

```text
NAME               READY   STATUS    RESTARTS        AGE   IP              NODE
prometheus-k8s-0   2/2     Running   2 (3d16h ago)  29d   10.233.107.16   node3-192-168-201-103
```

这与最初在 `node3-192-168-201-103` 上发现 `/dev/rbd4` D 状态等待的现场一致。

现在才能严谨地说：

> **前面出现 D 状态等待的 `/dev/rbd4`，正是 `prometheus-k8s-0` 持久化数据卷所使用的 Ceph RBD 设备。**

这一步只确认“这个设备属于哪个业务”。

至于 `rbd4` 到底有多慢，以及问题是否只发生在这个 Prometheus volume 上，还需要继续通过 `iostat` 验证。

## 6. 定向测 rbd4：直接看到高写延迟

前面已经确认 D 状态线程指向 `/dev/rbd4`，因此直接对这个设备做定向采样：

```bash
iostat -xmd rbd4 1 10
```

当时的原始输出如下：

```text
Linux 5.4.0-65-generic (node3-192-168-201-103)  09/19/2026      _x86_64_        (8 CPU)

Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wMB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dMB/s   drqm/s  %drqm d_await dareq-sz  aqu-sz  %util
rbd4             1.22      0.17     0.00   0.03   37.58   143.43    0.44      0.20     0.39  46.77  220.59   476.81    0.00      0.00     0.00   0.00    0.00     0.00    0.14   3.86
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     1.00 100.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.40
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    1.00      0.01     0.00   0.00 2283.00     8.00    0.00      0.00     0.00   0.00    0.00     0.00    2.28 228.40
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    1.00      0.00     0.00   0.00 1514.00     4.00    0.00      0.00     0.00   0.00    0.00     0.00    1.51 151.60
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    4.00      0.02     1.00  20.00  323.50     5.00    0.00      0.00     0.00   0.00    0.00     0.00    1.28  74.40
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
```

`iostat` 没有加 `-y`，所以第一行 `rbd4` 是自系统启动以来的累计统计，后面 9 行才是每秒采样。

真正需要关注的是后面的区间数据。

其中一秒内只有：

```text
w/s     = 1.00
wMB/s   = 0.01
```

但：

```text
w_await = 2283.00 ms
```

另一组：

```text
w/s     = 1.00
w_await = 1514.00 ms
```

还有一组：

```text
w/s     = 4.00
wMB/s   = 0.02
w_await = 323.50 ms
```

也就是说，`rbd4` 并没有很高的写吞吐，但单次写 I/O 的等待时间可以达到数百毫秒甚至 1～2 秒。

这解释了最初看到的现象：

> **高 iowait 并不要求高吞吐。少量 I/O 只要完成得足够慢，同样会让任务长时间等待。**

因此，不能因为“磁盘吞吐不高”就排除存储延迟问题。

## 7. 同时观察多个 RBD：高延迟并不只出现在 rbd4

如果只有 `rbd4` 慢，问题仍然可能局限在 Prometheus 对应的这个 volume。

所以继续同时观察 node3 上的多个 RBD：

```bash
iostat -xmd rbd0 rbd1 rbd2 rbd3 rbd4 1 5
```

第一组累计统计为：

```text
Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wMB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dMB/s   drqm/s  %drqm d_await dareq-sz  aqu-sz  %util
rbd0             0.01      0.00     0.01  48.96  114.20    20.28    6.82      0.06     1.78  20.69   42.19     9.70    0.00      0.00     0.00   0.00    0.00     0.00    0.28  12.61
rbd1             0.00      0.00     0.00  22.48   64.72    11.86    0.00      0.00     0.00  55.26   65.24   213.57    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.01
rbd2             0.00      0.00     0.00   0.00   33.88    10.25    0.00      0.00     0.00  31.21   46.91   113.62    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.01
rbd3             0.02      0.00     0.00  14.49   53.87    27.98    4.20      0.09    10.94  72.24   42.93    22.83    0.00      0.00     0.00   0.00    0.00     0.00    0.17   8.06
rbd4             1.22      0.17     0.00   0.03   37.58   143.43    0.44      0.20     0.39  46.77  220.63   476.81    0.00      0.00     0.00   0.00    0.00     0.00    0.14   3.86
```

后面的 4 个 1 秒区间里，`rbd1` 和 `rbd2` 都没有实际 I/O。它们的原始设备行重复为：

```text
rbd1             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
rbd2             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
```

所以这两个设备在这段短采样窗口里没有足够 I/O，不能根据 `await=0` 判断它们背后的 Ceph 路径没有问题。

有实际 I/O 的设备里，原始采样包括：

```text
rbd0             0.00      0.00     0.00   0.00    0.00     0.00   17.00      0.10     0.00   0.00  200.18     5.88    0.00      0.00     0.00   0.00    0.00     0.00    3.38  94.80
rbd3             0.00      0.00     0.00   0.00    0.00     0.00    6.00      0.11    21.00  77.78  178.17    18.67    0.00      0.00     0.00   0.00    0.00     0.00    1.06  46.40

rbd0             0.00      0.00     0.00   0.00    0.00     0.00   13.00      0.07     0.00   0.00  254.77     5.54    0.00      0.00     0.00   0.00    0.00     0.00    3.28 108.00
rbd3             0.00      0.00     0.00   0.00    0.00     0.00    1.00      0.00     0.00   0.00  734.00     4.00    0.00      0.00     0.00   0.00    0.00     0.00    0.73  73.20
rbd4             0.00      0.00     0.00   0.00    0.00     0.00    2.00      0.02     3.00  60.00   40.00    10.00    0.00      0.00     0.00   0.00    0.00     0.00    0.08   8.40

rbd0             0.00      0.00     0.00   0.00    0.00     0.00   12.00      0.09     0.00   0.00   83.33     7.67    0.00      0.00     0.00   0.00    0.00     0.00    0.97  98.00

rbd0             0.00      0.00     0.00   0.00    0.00     0.00    7.00      0.11    13.00  65.00  260.29    15.43    0.00      0.00     0.00   0.00    0.00     0.00    1.80  64.40
rbd3             0.00      0.00     0.00   0.00    0.00     0.00    3.00      0.16    39.00  92.86  279.00    56.00    0.00      0.00     0.00   0.00    0.00     0.00    0.83  84.00
```

最明显的是：

```text
rbd0 w_await:
200.18 ms
254.77 ms
83.33 ms
260.29 ms

rbd3 w_await:
178.17 ms
734.00 ms
279.00 ms

rbd4:
220.63 ms（累计统计）
323.50 ms
1514.00 ms
2283.00 ms
```

这里并不能说明 node3 上所有 RBD 都同样异常，但至少可以确认：

> **高延迟并不只出现在 Prometheus 对应的 rbd4。**

`rbd0` 和 `rbd3` 也出现了数百毫秒级写等待，而 `rbd1`、`rbd2` 在这段采样窗口内几乎没有 I/O，因此没有足够数据做同样的判断。

排查重点由此从单个 Prometheus PVC 扩大到它们共同经过的 Ceph 存储路径：

```text
RBD Client
    ↓
Ceph
    ↓
OSD
    ↓
OSD Backing Storage
```

## 8. 进入 Ceph：OSD latency 也有异常

继续在 Ceph 侧执行：

```bash
ceph osd perf
```

完整输出：

```text
osd  commit_latency(ms)  apply_latency(ms)
  0                  20                 20
  2                  13                 13
  1                  65                 65
```

其中：

```text
osd.1 = 65 / 65 ms
```

最为突出。

到这里，客户端和 Ceph 存储侧已经出现两组互相独立的证据：

```text
Kubernetes Node:
多个 RBD w_await 达到数百毫秒甚至秒级

Ceph:
OSD commit/apply latency 达到几十毫秒
```

因此问题已经不能仅用 Prometheus 的写入行为解释。

---

## 9. 当时存在 deep scrub，但它只能作为影响因素

继续查看正在 scrub 的 PG：

```bash
ceph pg dump pgs_brief | grep -E 'scrub|deep'
```

关键输出：

```text
dumped pgs_brief
8.0   active+clean+scrubbing+deep   [0,1,2]   0   [0,1,2]   0
```

这里可以看到：

```text
PG 8.0
状态：active+clean+scrubbing+deep

up:
[0,1,2]

acting:
[0,1,2]
```

集群一共就是 3 个 OSD，因此这个 deep scrub 会涉及全部三个 OSD。

所以它确实可能：

- 增加后台读取；
- 占用 OSD I/O；
- 放大已有的存储延迟。

但这条输出本身仍然不能证明：

```text
deep scrub = 根因
```

因为此时已经看到：

- `rbd0`、`rbd3`、`rbd4` 都出现了明显高延迟；
- `ceph osd perf` 也慢；
- 后面还会看到 BlueStore slow ops；
- OSD VM 自身的磁盘也会出现高等待。

因此更严谨的判断是：

> **Deep scrub 可能是当时的放大因素，但不足以被单独定为根因。**

---

## 10. BlueStore 自己也报告 slow operation

继续执行：

```bash
ceph health detail
```

当时输出中包含：

```text
HEALTH_WARN 2 OSD(s) experiencing slow operations in BlueStore

[WRN] BLUESTORE_SLOW_OP_ALERT:
2 OSD(s) experiencing slow operations in BlueStore

osd.0 observed slow operation indications in BlueStore
osd.1 observed slow operation indications in BlueStore
```

到这里已经不是只有 Kubernetes Client 认为 RBD 慢：

> **Ceph 自己也在 OSD / BlueStore 层报告 slow operation。**

排查路径继续向下：

```text
RBD
 ↓
Ceph OSD
 ↓
BlueStore
 ↓
OSD Backing Storage
```

---

## 11. 把 OSD 映射到 Ceph 主机和虚拟磁盘

前面已经看到 OSD 层的 latency 和 BlueStore slow operation。

下一步需要确认：

```text
osd.0 / osd.1 / osd.2
```

分别运行在哪台主机，又使用哪个块设备。

分别查看三个 OSD 的 metadata：

```bash
ceph osd metadata 0
ceph osd metadata 1
ceph osd metadata 2
```

与这次排障直接相关的字段如下：

```text
osd.0

"hostname": "Demo-Ceph-04"
"devices": "sdb"
"device_ids": "sdb=QEMU_HARDDISK_drive-scsi1"
```

```text
osd.1

"hostname": "Demo-Ceph-05"
"devices": "sdb"
"device_ids": "sdb=QEMU_HARDDISK_drive-scsi1"
```

```text
osd.2

"hostname": "Demo-Ceph-06"
"devices": "sdb"
"device_ids": "sdb=QEMU_HARDDISK_drive-scsi1"
```

对应关系为：

```text
osd.0 → Demo-Ceph-04 → /dev/sdb
osd.1 → Demo-Ceph-05 → /dev/sdb
osd.2 → Demo-Ceph-06 → /dev/sdb
```

三个 OSD 的 `device_ids` 都显示：

```text
QEMU_HARDDISK_drive-scsi1
```

说明 Ceph OSD VM 看到的 `/dev/sdb` 是 QEMU 提供的虚拟磁盘。


## 12. OSD VM 内的 /dev/sdb 也出现高等待

既然三个 OSD 最终都落到各自 Ceph VM 的 `/dev/sdb`，下一步就在三台 OSD VM 内直接观察这个设备：

```bash
iostat -xmd sdb 1 10
```

同样需要注意：没有加 `-y` 时，第一组是自系统启动以来的累计统计，后面才是 1 秒区间报告。

### Demo-Ceph-04

当时的原始 `sdb` 数据：

```text
Linux 5.15.0-187-generic (Demo-Ceph-04)         09/19/2026      _x86_64_        (8 CPU)

Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wMB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dMB/s   drqm/s  %drqm d_await dareq-sz     f/s f_await  aqu-sz  %util
sdb             14.69      0.75     6.16  29.55   80.32    52.53  384.91      6.86   423.88  52.41    1.84    18.25    0.00      0.00     0.00   0.00    0.00     0.00  160.18     0.11    0.35  37.01
sdb            188.00      4.72    41.00  17.90  180.57    25.72  267.00      6.83   350.00  56.73   20.51    26.19    0.00      0.00     0.00   0.00    0.00     0.00   58.00     0.14   39.43  90.40
sdb            103.00      0.89     6.00   5.50  156.78     8.85   43.00      3.08   121.00  73.78   27.35    73.40    0.00      0.00     0.00   0.00    0.00     0.00   21.00     0.19   17.33  77.20
sdb            165.00      1.41     5.00   2.94  185.60     8.73   28.00      2.23   120.00  81.08   82.07    81.43    0.00      0.00     0.00   0.00    0.00     0.00   13.00     0.15   32.92 101.20
sdb            218.00      4.09    21.00   8.79  144.94    19.23  175.00      3.20   215.00  55.13   18.29    18.74    0.00      0.00     0.00   0.00    0.00     0.00   57.00     0.12   34.80  96.40
sdb            187.00     24.57   210.00  52.90    8.18   134.55  169.00      3.38   102.00  37.64    3.81    20.47    0.00      0.00     0.00   0.00    0.00     0.00   51.00     0.14    2.18  69.20
sdb            183.00      1.69     9.00   4.69  264.56     9.44   31.00      1.91    89.00  74.17   11.19    63.10    0.00      0.00     0.00   0.00    0.00     0.00   14.00     0.14   48.76  97.60
sdb            194.00      0.77     1.00   0.51  347.43     4.06    4.00      0.15     1.00  20.00   90.00    39.00    0.00      0.00     0.00   0.00    0.00     0.00    2.00     0.00   67.76  90.80
sdb            188.00      0.77     0.00   0.00  277.39     4.19   18.00      2.23   206.00  91.96  202.50   127.11    0.00      0.00     0.00   0.00    0.00     0.00    8.00     0.25   55.80  97.60
sdb            212.00      1.07    11.00   4.93  246.32     5.19  145.00      5.27   185.00  56.06  163.03    37.21    0.00      0.00     0.00   0.00    0.00     0.00   20.00     0.15   75.86  94.40
```

其中比较突出的区间包括：

```text
r_await = 347.43 ms
w_await = 90.00 ms
aqu-sz  = 67.76
```

以及：

```text
r_await = 277.39 ms
w_await = 202.50 ms
aqu-sz  = 55.80
```

最后一组还出现：

```text
r_await = 246.32 ms
w_await = 163.03 ms
aqu-sz  = 75.86
```

### Demo-Ceph-05

原始 `sdb` 数据：

```text
Linux 5.15.0-187-generic (Demo-Ceph-05)         09/19/2026      _x86_64_        (8 CPU)

Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wMB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dMB/s   drqm/s  %drqm d_await dareq-sz     f/s f_await  aqu-sz  %util
sdb             11.59      0.53     4.30  27.04  104.15    47.01  384.45      6.86   424.15  52.45    1.78    18.28    0.00      0.00     0.00   0.00    0.00     0.00  160.10     0.11    0.36  35.86
sdb            127.00      0.57     0.00   0.00  280.26     4.63  107.00     38.16   581.00  84.45   41.69   365.23    0.00      0.00     0.00   0.00    0.00     0.00   34.00     0.26   40.06  97.20
sdb            117.00      0.50     0.00   0.00  265.25     4.34  134.00     19.88   347.00  72.14  251.28   151.91    0.00      0.00     0.00   0.00    0.00     0.00   24.00     0.21   64.71 101.20
sdb            183.00      6.49    56.00  23.43  153.35    36.31  281.00     12.18   632.00  69.22    7.83    44.37    0.00      0.00     0.00   0.00    0.00     0.00   84.00     0.11   30.27  97.20
sdb            162.00     18.53   162.00  50.00   13.80   117.11 1085.00     13.38  1176.00  52.01    4.05    12.62    0.00      0.00     0.00   0.00    0.00     0.00  430.00     0.09    6.67  95.20
sdb             91.00      7.95    38.00  29.46   38.58    89.45  295.00     14.40   430.00  59.31    6.00    49.99    0.00      0.00     0.00   0.00    0.00     0.00  120.00     0.12    5.29  91.60
sdb             18.00      2.05    18.00  50.00   71.33   116.89   64.00     25.53   399.00  86.18   79.70   408.44    0.00      0.00     0.00   0.00    0.00     0.00   22.00     0.27    6.39  99.60
sdb            123.00     12.82    84.00  40.58   17.59   106.70  345.00     23.91   597.00  63.38    7.62    70.98    0.00      0.00     0.00   0.00    0.00     0.00   97.00     0.13    4.80  90.80
sdb            237.00     12.17   238.00  50.11   30.54    52.57  275.00      2.98   258.00  48.41    3.25    11.11    0.00      0.00     0.00   0.00    0.00     0.00  112.00     0.10    8.14  88.00
sdb            165.00     16.76   173.00  51.18   26.62   104.02  249.00      6.55   421.00  62.84    6.32    26.94    0.00      0.00     0.00   0.00    0.00     0.00   88.00     0.11    5.98  71.20
```

其中两组非常明显：

```text
r_await = 280.26 ms
w_await = 41.69 ms
aqu-sz  = 40.06
```

以及：

```text
r_await = 265.25 ms
w_await = 251.28 ms
aqu-sz  = 64.71
```

### Demo-Ceph-06

原始 `sdb` 数据：

```text
Linux 5.15.0-187-generic (Demo-Ceph-06)         09/19/2026      _x86_64_        (8 CPU)

Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wMB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dMB/s   drqm/s  %drqm d_await dareq-sz     f/s f_await  aqu-sz  %util
sdb             11.61      0.51     4.20  26.56   95.41    45.43  387.25      6.87   424.18  52.28    1.76    18.16    0.00      0.00     0.00   0.00    0.00     0.00  160.92     0.10    0.25  35.35
sdb             77.00     28.71     0.00   0.00   13.09   381.82    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    1.01  68.40
sdb             67.00     63.12     0.00   0.00   11.28   964.78    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.76  98.00
sdb             58.00     53.06     0.00   0.00   12.81   936.83    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.74  94.40
sdb             57.00     54.80     0.00   0.00   13.28   984.49    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.76  98.00
sdb             58.00     56.03     0.00   0.00   11.81   989.17    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.69  89.60
sdb             68.00     64.94     0.00   0.00   11.28   977.88    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.77 102.00
sdb             64.00     60.25     0.00   0.00   11.28   964.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.72  96.00
sdb             60.00     56.25     0.00   0.00   12.98   960.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.78  97.20
sdb             42.00     41.75     0.00   0.00   18.93  1017.90    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00     0.00    0.80  94.80
```

除第一组累计统计外，后面的区间读取延迟大多约为：

```text
11.28–18.93 ms
```

相较 `Demo-Ceph-04` 和 `Demo-Ceph-05` 的数百毫秒读取等待，差异非常明显。

这一步说明：

> **高延迟已经不只存在于 Kubernetes 的 RBD Client 层。继续向下追以后，在 OSD VM 自己的 `/dev/sdb` 上也能看到明显等待，而且三台 OSD VM 的表现并不一致。**

因此证据链继续向下收敛：

```text
Kubernetes RBD
        ↓
Ceph OSD / BlueStore
        ↓
OSD VM /dev/sdb
        ↓
QEMU Virtual Disk
```

下一步理论上应该继续进入 Hypervisor，确认这些 QEMU 虚拟盘最终落在哪个 PVE storage backend 和物理设备上。

## 13. 为什么不能直接下结论说“物理盘坏了”

此时能够确认的是：

```text
OSD VM /dev/sdb
        ↓
QEMU_HARDDISK_drive-scsi1
```

实际链路还要继续：

```text
QEMU Virtual Disk
        ↓
PVE / Hypervisor Storage
        ↓
真正的物理存储
```

理论上的下一步应该进入 PVE：

```bash
qm config <vmid>
```

确认 VM disk 的：

- storage backend；
- cache mode；
- raw / qcow2；
- LVM-thin / ZFS / 其他后端；
- 是否真正做了磁盘、HBA 或 PCI passthrough；
- 最终对应哪个物理设备。

然后在宿主机继续：

```bash
iostat -x 1
smartctl -a /dev/<physical-disk>
```

但这次没有 PVE / Hypervisor 权限。

由于当时没有 Hypervisor 层的访问权限，现场证据只能追到 OSD VM 的 QEMU 虚拟磁盘这一层。

不能在没有证据的情况下写：

```text
某块物理磁盘损坏
```

也不能写：

```text
PVE 某种 storage backend 就是根因
```

---

## 14. 最终证据链

整个排查过程可以压缩成：

```text
atop
CPU wait 203%
但 sda 吞吐不高、avio ≈ 2.67 ms
        ↓
mpstat / vmstat
平均 %iowait ≈ 30.43%
vmstat b 最高 10、wa 最高 53%
        ↓
D 状态线程
jbd2/rbd4-8 → wait_on_buffer
        ↓
rook-ceph CSI 容器内执行 rbd device list
rbd4 → csi-vol-82a11e26-...
        ↓
PV
pvc-802412b9-debe-4945-9204-867c3b60f25d
        ↓
PVC
monitoring/data-prometheus-k8s-0
        ↓
Pod
prometheus-k8s-0
        ↓
（Pod 调度位置与最初排查节点 node3 一致）
        ↓
iostat -xmd rbd4 1 10
w_await 从 200ms+ 到 1.5～2.3s
        ↓
多个 RBD
rbd0 / rbd3 同样高延迟
        ↓
ceph osd perf
osd.1 = 65 / 65 ms
        ↓
deep scrub
PG 8.0 → [0,1,2]
        ↓
ceph health detail
BLUESTORE_SLOW_OP_ALERT
        ↓
OSD metadata
OSD → Demo-Ceph-04/05/06 → /dev/sdb
        ↓
OSD VM iostat
Demo-Ceph-04/05 出现数百毫秒 await
        ↓
QEMU_HARDDISK_drive-scsi1
        ↓
没有 PVE 权限
```

因此，这次能够严谨确认的结论是：

> **Prometheus 是明确受到影响的业务之一，但没有证据证明它是根因。**

同时可以确认：

> **Kubernetes 节点的高 iowait 与 Ceph RBD 路径中的高 I/O 延迟有关，而且异常继续出现在 Ceph OSD / BlueStore 和 OSD VM 的虚拟磁盘层。**

更准确地说：

> **问题已经收敛到 Ceph OSD 后端存储链路存在明显性能异常。**

但由于没有 Hypervisor 权限：

> **无法继续确认最终瓶颈究竟位于 PVE backing storage、虚拟磁盘层还是具体物理设备。**

---

## 15. 这次排查真正值得复用的方法

这次最有价值的并不是某一个 Ceph 参数，而是排查顺序：

```text
先观察
↓
再证明
↓
再定位设备
↓
再映射业务
↓
再验证共享存储
↓
再向底层追
```

具体来说：

```bash
atop
```

先看到异常。

```bash
mpstat -P ALL 1 10
vmstat 1 10
```

确认系统确实存在持续 I/O wait。

```bash
ps -eLo pid,tid,stat,wchan:40,comm,args | awk '$3 ~ /^D/'
```

让 D 状态线程告诉我们在等哪个设备。

随后才有理由执行：

```bash
iostat -xmd rbd4 1 10
```

再把：

```text
设备
```

映射成：

```text
RBD image
→ PV
→ PVC
→ Pod
→ Node
```

最后再去验证：

```text
Ceph
→ OSD
→ BlueStore
→ OSD backing disk
```

这条顺序比一开始就猜：

```text
Prometheus 太重
```

或者：

```text
Ceph scrub 导致
```

更可靠。

---

## 结论

这次故障最初只是一个看似矛盾的现象：

```text
CPU iowait 很高
但 sda 的读写量和 avio 并不高
```

真正把问题定位下去的关键，不是某一个经验判断，而是一系列命令和输出：

```text
atop
↓
mpstat / vmstat
↓
D 状态线程
↓
rbd4
↓
RBD image
↓
PV
↓
Prometheus PVC
↓
Prometheus Pod
↓
定向 iostat
↓
多个 RBD
↓
Ceph OSD
↓
deep scrub / BlueStore
↓
OSD VM /dev/sdb
↓
QEMU Virtual Disk
```

最终证据支持：

> **Prometheus 是受影响业务之一，而不是已经被证明的故障制造者。**

同时：

> **Ceph RBD 到 OSD 后端存储链路存在明显高延迟。**

而权限边界决定了最后一层结论：

> **没有 PVE / Hypervisor 权限，因此不能继续声称已经定位到某块物理磁盘或某个具体宿主机存储后端。**

本文记录的是故障定位过程，而不是已经完成的物理层修复。最终修复仍需要具备 Hypervisor 权限后继续验证底层 storage backend 和物理设备。

对于基础设施排障，最重要的一条原则仍然是：

> **每一个判断，都应该能够指回产生这个判断的命令和原始输出。**

---

## 相关阅读

如果你还在排查 Kubernetes 与 Ceph 的存储问题，可以继续看：

- [Kubernetes + Rook Ceph：FailedMount 提示 RBD image is still being used 怎么排查](/zh/blog/rook-ceph-rbd-image-still-being-used-failedmount/)
- [CephFS HEALTH_WARN：MDS_CLIENT_LATE_RELEASE 与 MDS_SLOW_REQUEST 排查](/zh/blog/cephfs-client-late-release-mds-slow-request/)
