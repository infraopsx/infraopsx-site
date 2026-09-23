---
layout: ../../../layouts/ArticleLayout.astro
title: "Kubernetes High iowait, Low Throughput: Ceph RBD/OSD Latency"
description: "A real Kubernetes + Ceph RBD investigation tracing high iowait through D-state tasks, iostat, PV/PVC mappings and OSD latency into the Ceph backend storage path."
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

While inspecting Kubernetes node `node3-192-168-201-103` with `atop`, CPU I/O wait was clearly elevated.

<figure style="margin:1.5rem auto;text-align:center;">
  <a
    href="/images/articles/kubernetes-ceph-rbd-high-iowait-latency/atop-high-iowait.png"
    target="_blank"
    rel="noopener"
  >
    <img
      src="/images/articles/kubernetes-ceph-rbd-high-iowait-latency/atop-high-iowait.png"
      alt="atop showing elevated Kubernetes node I/O wait"
      style="display:block;width:100%;max-width:760px;height:auto;margin:0 auto;cursor:zoom-in;"
      loading="lazy"
    />
  </a>
  <figcaption style="margin-top:.5rem;font-size:.9rem;opacity:.75;">
    The original atop screenshot from the incident.
  </figcaption>
</figure>

The important fields were:

```text
8 CPUs
wait 203%

sda:
busy  ≈ 51%
read  ≈ 2.1 MB/s
write ≈ 0.1 MB/s
avio  ≈ 2.67 ms
```

Because `atop` aggregates CPU percentages, `wait 203%` across eight CPUs is roughly 25% of total CPU time waiting on I/O.

Yet the local `sda` metrics did not show enough throughput or average I/O time to explain that wait.

The next question was therefore:

> **Which I/O were these CPUs actually waiting for?**

---

## 1. atop exposed a mismatch

The initial observation was:

```text
high CPU I/O wait
```

while local `sda` showed:

```text
modest throughput
avio ≈ 2.67 ms
```

That was not enough evidence to blame the local disk.

The next step was to confirm whether I/O wait was sustained and whether tasks were blocked in uninterruptible sleep.

---

## 2. mpstat and vmstat confirmed sustained I/O wait

First:

```bash
mpstat -P ALL 1 10
```

The 10-second average included:

```text
Average:     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle
Average:     all   18.01    0.00    9.79   30.43    0.00    1.31    0.05    0.00    0.00   40.40
```

Then:

```bash
vmstat 1 10
```

The complete samples were:

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

`b` reached 10 and `wa` reached 53%, confirming that the node really had tasks waiting on I/O.

---

## 3. D-state tasks pointed to rbd4

Run:

```bash
ps -eLo pid,tid,stat,wchan:40,comm,args | awk '$3 ~ /^D/'
```

The options mean:

```text
-e        all processes
-L        show threads
-o        custom output columns
pid/tid   process and thread IDs
stat      task state
wchan:40  current kernel wait channel, width 40
comm      command name
args      command arguments
```

The final `awk` keeps rows whose state begins with `D`, including `D`, `Ds`, `Dsl`, and `Dl`.

The key output included:

```text
  13902   13902 Ds   wait_on_page_bit  postgres        postgres: gatorcloud-pg: logger
 188161  188185 Dsl  wait_on_page_bit  etcd            etcd ...
1807859 1807859 Ds   wait_on_page_bit  postgres        postgres: gatorcloud-pg: grafana grafana ... INSERT
2476335 2476335 D    wait_on_buffer    jbd2/rbd4-8     [jbd2/rbd4-8]
2934503 2935843 Dl   wait_on_page_bit  elasticsearch   /usr/share/elasticsearch/jdk/bin/java ...
```

The important line was:

```text
2476335 2476335 D wait_on_buffer jbd2/rbd4-8 [jbd2/rbd4-8]
```

The ext4 journaling thread was blocked on `rbd4`.

That was the first device-specific clue.

---

## 4. Confirm which RBD image belongs to rbd4 through the CSI plugin

The previous step had already shown a D-state journaling thread on `rbd4`:

```text
2476335 2476335 D wait_on_buffer jbd2/rbd4-8 [jbd2/rbd4-8]
```

The next question was which Ceph RBD image `/dev/rbd4` represented.

The Kubernetes node did not have the `rbd` CLI installed, so the query was run inside the CSI RBD plugin Pod on node3:

```bash
kubectl -n rook-ceph exec -it csi-rbdplugin-ktkvl \
  -c csi-rbdplugin -- rbd device list
```

Output:

```text
id  pool  namespace  image                                           snap  device
0   rbd              csi-vol-dd591ece-7af9-43fc-b55c-94e9da9f2e89  -     /dev/rbd0
1   rbd              csi-vol-b9798af4-a5d5-4c97-a22e-740862997874  -     /dev/rbd1
2   rbd              csi-vol-0efd576e-a960-4761-a3c9-354ce4203d68  -     /dev/rbd2
3   rbd              csi-vol-a08a64bb-01b3-4d7a-ac21-7a5b34a03bef  -     /dev/rbd3
4   rbd              csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd  -     /dev/rbd4
```

That established:

```text
/dev/rbd4
        ↓
rbd/csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
```

At this point, that was all we knew: `rbd4` mapped to a CSI-managed Ceph RBD image.

We still needed to identify the Kubernetes PV, PVC, and Pod behind it.

---

## 5. Trace the RBD image through PV, PVC, and the Prometheus Pod

The only known identifier was:

```text
csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
```

Search all PVs by CSI `imageName`:

```bash
kubectl get pv \
  -o jsonpath='{range .items[*]}{.metadata.name}{"	"}{.spec.csi.volumeAttributes.imageName}{"	"}{.spec.claimRef.namespace}{"/"}{.spec.claimRef.name}{"
"}{end}' \
  | grep 'csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd'
```

Actual output:

```text
pvc-802412b9-debe-4945-9204-867c3b60f25d    csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd    monitoring/data-prometheus-k8s-0
```

That directly linked:

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

Inspect the PV directly:

```bash
kubectl get pv pvc-802412b9-debe-4945-9204-867c3b60f25d -o yaml
```

The important fields were:

```yaml
metadata:
  name: pvc-802412b9-debe-4945-9204-867c3b60f25d

spec:
  claimRef:
    name: data-prometheus-k8s-0
    namespace: monitoring

  csi:
    driver: rook-ceph.rbd.csi.ceph.com
    fsType: ext4

    volumeAttributes:
      imageName: csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
      pool: rbd
```

So the mapping was now:

```text
/dev/rbd4
        ↓
csi-vol-82a11e26-3406-4663-8f83-dee8b985e6dd
        ↓
PV pvc-802412b9-debe-4945-9204-867c3b60f25d
        ↓
PVC monitoring/data-prometheus-k8s-0
```

Next, identify which Pod uses the PVC:

```bash
kubectl -n monitoring describe pvc data-prometheus-k8s-0
```

Relevant output:

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

The complete business mapping was therefore:

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

Verify the Pod volume reference:

```bash
kubectl -n monitoring get pod prometheus-k8s-0 \
  -o jsonpath='{range .spec.volumes[*]}{.name}{"	"}{.persistentVolumeClaim.claimName}{"
"}{end}'
```

Output:

```text
data    data-prometheus-k8s-0
config
tls-assets
config-out
prometheus-k8s-rulefiles-0
web-config
kube-api-access-k8pnb
```

Because the investigation had started on `node3-192-168-201-103`, checking the Pod placement at this point was only a consistency check:

```bash
kubectl -n monitoring get pod prometheus-k8s-0 -o wide
```

Output:

```text
NAME               READY   STATUS    RESTARTS        AGE   IP              NODE
prometheus-k8s-0   2/2     Running   2 (3d16h ago)  29d   10.233.107.16   node3-192-168-201-103
```

That matched the original investigation location.

We could now say, without inference:

> **The `/dev/rbd4` device involved in the earlier D-state wait was the Ceph RBD device backing the persistent volume used by `prometheus-k8s-0`.**

This step only identified ownership. The next step was to measure how slow `rbd4` actually was.

## 6. Targeted iostat on rbd4 showed severe write latency

The D-state thread had already pointed to `/dev/rbd4`, so the device was sampled directly:

```bash
iostat -xmd rbd4 1 10
```

The raw output from the incident was:

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

Because `-y` was not used, the first `rbd4` row is the cumulative report since boot; the following nine rows are one-second interval reports.

The interval reports are what matter here.

One interval had only:

```text
w/s     = 1.00
wMB/s   = 0.01
```

yet:

```text
w_await = 2283.00 ms
```

Another interval:

```text
w/s     = 1.00
w_await = 1514.00 ms
```

And another:

```text
w/s     = 4.00
wMB/s   = 0.02
w_await = 323.50 ms
```

`rbd4` was not pushing high write throughput, yet individual write I/O latency reached hundreds of milliseconds and even 1–2 seconds.

This explains the original observation:

> **High iowait does not require high throughput. A small number of slow I/O operations can keep tasks waiting for a long time.**

Low throughput therefore does not rule out a storage-latency problem.

## 7. Multiple RBD devices showed that the high latency was not isolated to rbd4

If only `rbd4` were slow, the problem could still have been isolated to the Prometheus-backed volume.

Several RBD devices on node3 were therefore sampled together:

```bash
iostat -xmd rbd0 rbd1 rbd2 rbd3 rbd4 1 5
```

The cumulative report was:

```text
Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wMB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dMB/s   drqm/s  %drqm d_await dareq-sz  aqu-sz  %util
rbd0             0.01      0.00     0.01  48.96  114.20    20.28    6.82      0.06     1.78  20.69   42.19     9.70    0.00      0.00     0.00   0.00    0.00     0.00    0.28  12.61
rbd1             0.00      0.00     0.00  22.48   64.72    11.86    0.00      0.00     0.00  55.26   65.24   213.57    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.01
rbd2             0.00      0.00     0.00   0.00   33.88    10.25    0.00      0.00     0.00  31.21   46.91   113.62    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.01
rbd3             0.02      0.00     0.00  14.49   53.87    27.98    4.20      0.09    10.94  72.24   42.93    22.83    0.00      0.00     0.00   0.00    0.00     0.00    0.17   8.06
rbd4             1.22      0.17     0.00   0.03   37.58   143.43    0.44      0.20     0.39  46.77  220.63   476.81    0.00      0.00     0.00   0.00    0.00     0.00    0.14   3.86
```

In all four one-second interval reports, `rbd1` and `rbd2` had no actual I/O. Their raw device rows repeated as:

```text
rbd1             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
rbd2             0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00      0.00     0.00   0.00    0.00     0.00    0.00   0.00
```

So `await=0` for those two devices in this short window does not prove that their shared Ceph path was healthy; there was simply not enough I/O to measure latency meaningfully.

The active devices included these raw samples:

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

The clearest samples were:

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
220.63 ms (cumulative report)
323.50 ms
1514.00 ms
2283.00 ms
```

This does not mean that every RBD on node3 was equally affected. It does establish that the high latency was not unique to the Prometheus-backed `rbd4`.

`rbd0` and `rbd3` also showed write latency in the hundreds of milliseconds, while `rbd1` and `rbd2` had too little I/O in this sampling window to make the same judgment.

That shifted the investigation from a single Prometheus PVC toward the shared Ceph storage path:

```text
RBD Client
    ↓
Ceph
    ↓
OSD
    ↓
OSD Backing Storage
```

## 8. Ceph OSD latency showed the same problem from the storage side

```bash
ceph osd perf
```

Output:

```text
osd  commit_latency(ms)  apply_latency(ms)
  0                  20                 20
  2                  13                 13
  1                  65                 65
```

`osd.1` stood out at `65 / 65 ms`.

The client and storage-side observations were now independent but consistent.

---

## 9. Deep scrub was present, but it was only a possible amplifier

```bash
ceph pg dump pgs_brief | grep -E 'scrub|deep'
```

Output:

```text
dumped pgs_brief
8.0   active+clean+scrubbing+deep   [0,1,2]   0   [0,1,2]   0
```

PG `8.0` was deep-scrubbing across all three OSDs.

That could add background read pressure, but it was not enough evidence to declare scrub the root cause.

---

## 10. BlueStore reported slow operations

```bash
ceph health detail
```

Relevant output:

```text
HEALTH_WARN 2 OSD(s) experiencing slow operations in BlueStore

[WRN] BLUESTORE_SLOW_OP_ALERT:
2 OSD(s) experiencing slow operations in BlueStore

osd.0 observed slow operation indications in BlueStore
osd.1 observed slow operation indications in BlueStore
```

Ceph itself was reporting slow operations inside the OSD/BlueStore path.

---

## 11. Map each OSD to its Ceph host and guest disk

The OSD layer had already shown latency and BlueStore slow operations.

Each OSD was then checked separately:

```bash
ceph osd metadata 0
ceph osd metadata 1
ceph osd metadata 2
```

The incident-relevant metadata fields were:

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

The mapping was:

```text
osd.0 → Demo-Ceph-04 → /dev/sdb
osd.1 → Demo-Ceph-05 → /dev/sdb
osd.2 → Demo-Ceph-06 → /dev/sdb
```

All three `device_ids` contained:

```text
QEMU_HARDDISK_drive-scsi1
```

So the OSD VMs were seeing QEMU virtual disks. This still did not identify the final hypervisor storage backend or physical device.

## 12. The OSD VM /dev/sdb devices also showed latency

The same backing device was measured inside each OSD VM:

```bash
iostat -xmd sdb 1 10
```

Without `-y`, the first report is cumulative since boot and the subsequent reports are one-second intervals.

### Demo-Ceph-04

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

The interval reports included read await values of 347.43, 277.39 and 246.32 ms, with write await reaching 202.50 ms.

### Demo-Ceph-05

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

Two particularly clear samples were:

```text
r_await = 280.26 ms
w_await = 41.69 ms
aqu-sz  = 40.06
```

and:

```text
r_await = 265.25 ms
w_await = 251.28 ms
aqu-sz  = 64.71
```

### Demo-Ceph-06

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

Excluding the first cumulative report, read await was mostly in the 11.28–18.93 ms range, clearly lower than the hundreds of milliseconds seen on Demo-Ceph-04 and Demo-Ceph-05.

The latency was therefore visible below the Kubernetes RBD client as well, inside the OSD guest-disk layer, and the three OSD VMs did not behave identically.

## 13. Why the investigation could not claim a failed physical disk

The observed path ended at:

```text
OSD VM /dev/sdb
        ↓
QEMU_HARDDISK_drive-scsi1
        ↓
PVE / hypervisor storage
        ↓
physical storage
```

The correct next step would have been:

```bash
qm config <vmid>
```

followed by host-level:

```bash
iostat -x 1
smartctl -a /dev/<physical-disk>
```

But PVE/hypervisor access was unavailable.

Without hypervisor-level access, the incident evidence could only be traced as far as the QEMU virtual disk exposed to the OSD VM.

---

## 14. Final evidence chain

```text
atop
wait 203%
local sda throughput modest, avio ≈ 2.67 ms
        ↓
mpstat / vmstat
average iowait ≈ 30.43%
b up to 10, wa up to 53%
        ↓
D-state task
jbd2/rbd4-8 → wait_on_buffer
        ↓
rbd device list inside rook-ceph CSI container
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
(Pod placement matches the original node3 investigation)
        ↓
targeted iostat
rbd4 w_await from 200ms+ to 1.5–2.3s
        ↓
multiple RBDs
rbd0 and rbd3 also slow
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
OSDs → Demo-Ceph-04/05/06 → /dev/sdb
        ↓
OSD VM iostat
hundreds of milliseconds of await on Demo-Ceph-04/05
        ↓
QEMU_HARDDISK_drive-scsi1
        ↓
no PVE access
```

The strongest supported conclusions were:

> **Prometheus was clearly affected, but was not proven to be the cause.**

and:

> **The Kubernetes iowait was tied to high latency in the Ceph RBD path, with the abnormal latency continuing into the OSD/BlueStore and OSD guest-disk layers.**

Without hypervisor access, the final physical root cause could not be confirmed.

---

## Conclusion

This incident started with a mismatch:

```text
CPU iowait was high
but local sda throughput and avio did not explain it
```

The investigation then followed evidence:

```text
atop
↓
mpstat / vmstat
↓
D-state task
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
targeted iostat
↓
multiple RBD devices
↓
Ceph OSD
↓
deep scrub / BlueStore
↓
OSD VM /dev/sdb
↓
QEMU virtual disk
```

The evidence supports:

> **Prometheus was an affected workload, not a proven cause.**

It also supports:

> **The Ceph RBD-to-OSD backing-storage path was experiencing significant latency.**

Because there was no PVE/hypervisor access, the investigation could not legitimately claim a specific host storage backend or physical disk as the final root cause.

---

## Related reading

For more Kubernetes and Ceph storage troubleshooting:

- [Kubernetes + Rook Ceph: Troubleshooting “RBD image is still being used” FailedMount](/blog/rook-ceph-rbd-image-still-being-used-failedmount/)
- [CephFS HEALTH_WARN: Troubleshooting MDS_CLIENT_LATE_RELEASE and MDS_SLOW_REQUEST](/blog/cephfs-client-late-release-mds-slow-request/)
