---
layout: ../../../../layouts/ArticleLayout.astro
title: "CephFS HEALTH_ERR：filesystem offline、MDS damaged 时怎么排查和恢复"
description: "一次 CephFS MDS rank damaged 导致 filesystem offline 的真实排障记录：如何看 health detail、fs dump、MDS standby，为什么 standby 不会自动接管，以及 ceph mds repaired 真正做了什么。"
pubDate: "2026-09-19"
category: Storage
tags:
  - Ceph
  - CephFS
  - MDS
  - Troubleshooting
  - Storage
enPath: "/blog/cephfs-mds-damaged-filesystem-offline-recovery/"
zhPath: "/zh/blog/cephfs-mds-damaged-filesystem-offline-recovery/"
---

这次故障的现象很典型：

```text
HEALTH_ERR
1 filesystem is degraded
1 filesystem is offline
1 mds daemon damaged
```

OSD 看起来却完全正常：

```text
3 osds: 3 up, 3 in
177 active+clean
```

同时还有两个 MDS standby。

第一眼很容易产生一个疑问：

> 既然有 standby MDS，为什么 active MDS 出问题以后，standby 没有自动顶上来？

真正的关键不是“有没有 standby”，而是：

```text
CephFS rank 0 已经被 Monitor 标记为 damaged
```

只要 rank 仍然是 damaged，standby 就不能像普通 failover 那样接管它。

> 文中的集群 ID、文件系统名、MDS 名称、IP、Pool 名称等都换成了通用示例。原现场版本是 Ceph Pacific 16.2.5。

## 先看现场状态

```bash
ceph status
```

类似：

```text
cluster:
  health: HEALTH_ERR
          1 filesystem is degraded
          1 filesystem is offline
          1 mds daemon damaged

services:
  mon: 3 daemons, quorum mon-a,mon-b,mon-c
  mgr: mgr-a(active)
  mds: 0/1 daemons up, 2 standby
  osd: 3 osds: 3 up, 3 in

data:
  volumes: 0/1 healthy, 1 recovering; 1 damaged
  pools:   11 pools, 177 pgs
  pgs:     177 active+clean
```

这里有两个不同层次的状态。

RADOS 这一层：

```text
OSD up/in
PG active+clean
```

说明底层对象存储当时没有明显的 PG 不可用问题。

CephFS 这一层：

```text
0/1 MDS active
filesystem offline
rank damaged
```

说明文件系统的元数据服务起不来。

所以：

> **PG 全部 active+clean，不等于 CephFS 一定健康。**

CephFS 还依赖 MDS 和 metadata pool 中的文件系统元数据。

## `ceph health detail` 已经把问题说得很清楚

```bash
ceph health detail
```

类似：

```text
HEALTH_ERR 1 filesystem is degraded; 1 filesystem is offline; 1 mds daemon damaged

[WRN] FS_DEGRADED: 1 filesystem is degraded
    fs prod-fs is degraded

[ERR] MDS_ALL_DOWN: 1 filesystem is offline
    fs prod-fs is offline because no MDS is active for it.

[ERR] MDS_DAMAGE: 1 mds daemon damaged
    fs prod-fs mds.0 is damaged
```

这三个信息其实是一条因果链：

```text
rank 0 damaged
        ↓
没有 MDS 能成为 rank 0 active
        ↓
filesystem offline
        ↓
filesystem degraded
```

真正应该优先理解的是：

```text
MDS_DAMAGE
```

而不是单独去“修” `FS_DEGRADED`。

## 为什么两个 standby 没有自动接管

继续看：

```bash
ceph mds stat
```

```text
prod-fs:0/1 2 up:standby, 1 damaged
```

这里：

```text
2 up:standby
```

说明 MDS daemon 本身是活着的。

但：

```text
1 damaged
```

说明有一个 MDS rank 被标记为 damaged。

MDS daemon 和 MDS rank 不是完全同一个概念。

可以简单理解成：

```text
MDS daemon
= 可以承担工作的进程

MDS rank
= 文件系统需要由某个 MDS daemon 承担的角色
```

现在的状态是：

```text
rank 0 = damaged
mds-a  = standby
mds-b  = standby
```

两个 standby 都存在，但 Monitor 不会把 damaged rank 当成普通 failed rank 直接交给 standby。

这就是为什么“明明有备用 MDS，文件系统却还是 offline”。

## `ceph fs dump` 里最容易看错的一行

```bash
ceph fs dump
```

精简以后：

```text
Filesystem 'prod-fs'

max_mds 1
in      0
up      {}
failed
damaged 0
stopped

data_pools      [2]
metadata_pool   1

Standby daemons:

[mds.prod-fs-b{-1:...} state up:standby ...]
[mds.prod-fs-a{-1:...} state up:standby ...]
```

这里：

```text
damaged 0
```

不是：

```text
damaged = false
```

它的意思是：

```text
rank 0 在 damaged 集合里
```

同时：

```text
up {}
```

说明当前没有 active rank。

而：

```text
in 0
```

表示 rank 0 是这个文件系统应该存在的 rank。

完整状态就是：

```text
文件系统需要 rank 0
        ↓
rank 0 被标记 damaged
        ↓
当前没有 daemon 能承接它
        ↓
两个 daemon 只能停在 standby
```

## 再用 `ceph fs status` 确认

```bash
ceph fs status
```

类似：

```text
prod-fs - 0 clients
====
RANK  STATE
 0    failed

       POOL           TYPE      USED   AVAIL
prod-fs-metadata    metadata    965M   640G
prod-fs-data        data        363G   640G

STANDBY MDS
  prod-fs-b
  prod-fs-a
```

这里能确认：

```text
rank 0 没有 active MDS
两个 standby 都在
```

如果客户端这时仍然挂载着 CephFS，元数据操作会停住或者失败。

## 先别急着执行 `ceph mds repaired`

这个地方很重要。

命令：

```bash
ceph mds repaired <role>
```

名字很容易让人误以为：

```text
执行以后 Ceph 会自动修复损坏的 metadata
```

实际上不是。

这个命令真正做的是：

> **清除这个 MDS rank 的 damaged 标记，让 standby MDS 可以再次尝试接管这个 rank。**

它本身不会修复 journal、inode、dentry 或 metadata table。

如果真正的底层 metadata 损坏仍然存在：

```text
ceph mds repaired
        ↓
standby 尝试接管
        ↓
再次读到损坏 metadata
        ↓
rank 又可能重新被标记 damaged
```

所以不能把：

```bash
ceph mds repaired 0
```

当成通用的“一键修 CephFS”。

## 清 damaged 标记前，我现在会先做什么

### 1. 保存现场

```bash
ceph status
ceph health detail
ceph mds stat
ceph fs status
ceph fs dump
```

可以保存下来：

```bash
ceph status > ceph-status.txt
ceph health detail > ceph-health-detail.txt
ceph fs dump > ceph-fs-dump.txt
```

如果后面需要做 metadata recovery，这些信息很有价值。

### 2. 确认底层 RADOS

```bash
ceph osd stat
ceph pg stat
ceph health detail
```

重点排除：

```text
inactive PG
incomplete PG
lost objects
metadata pool PG 异常
```

如果 metadata pool 本身存在丢对象或不可恢复 PG，就不能把问题当成一个单纯的 MDS 状态异常。

### 3. 看 MDS 日志

真正的 `damaged` 原因通常要从 MDS 日志里找。

例如：

```text
journal replay 失败
metadata object missing
decode error
assert
I/O error
damage table
```

重点不是固定某个日志路径，而是找到：

```text
rank 第一次进入 damaged 前发生了什么
```

### 4. 能访问 damage table 时再看 damage

有 active rank，或者能够正常执行对应 MDS admin command 时，可以查看：

```bash
ceph tell mds.<fs-name>:0 damage ls
```

可能会看到：

```text
DENTRY
DIR_FRAG
BACKTRACE
```

这种局部 metadata damage 有时可以通过 CephFS scrub repair 处理。

但如果 rank 根本无法启动，或者是 journal / MDS table 层面的损坏，就属于更深的 disaster recovery 范畴。

## Ceph 官方推荐的 damaged rank 思路

更安全的逻辑顺序是：

```text
先确认为什么 damaged
        ↓
修复真正的问题
        ↓
最后清除 damaged 标志
        ↓
让 standby 尝试接管
```

如果 rank 能启动，而且 damage 属于 scrub 能处理的类型，可以考虑：

```bash
ceph tell mds.prod-fs:0 scrub start / recursive,repair
```

实际情况可能还需要 `force`，但 scrub repair 也不是万能的。

如果涉及：

```text
journal 损坏
MDS table 损坏
严重 metadata corruption
```

应该进入 CephFS disaster recovery 流程，而不是继续试更多“看起来可能有用”的命令。

## 这次现场为什么 `repaired` 以后恢复了

当时实际执行过：

```bash
ceph mds fail prod-fs-b
ceph mds fail prod-fs-a
ceph mds repaired 0
```

之后：

```bash
ceph fs status
```

恢复为：

```text
prod-fs - 20 clients
====
RANK      STATE            MDS
 0        active           prod-fs-a
0-s       standby-replay   prod-fs-b
```

最终：

```bash
ceph health
```

变成：

```text
HEALTH_OK
```

从结果看，rank 0 在 damaged 标记清除后，有 standby 成功加载了这个 rank，并重新进入 active。

但这里要把两个命令的作用分开。

### `ceph mds fail`

```bash
ceph mds fail <name-or-role>
```

作用是把一个 MDS daemon 标记为 failed。

如果它当前是 active，并且有适合的 standby，Ceph 会触发 failover。

它不是：

```text
metadata repair
```

这次现场里先对两个 standby 执行 `mds fail` 最终没有阻止恢复，但我不会把它写成处理 `MDS_DAMAGE` 的标准步骤。

### `ceph mds repaired`

原环境执行的是：

```bash
ceph mds repaired 0
```

公开文档里我更推荐写明确的 role：

```bash
ceph mds repaired prod-fs:0
```

这样不用猜：

```text
0 到底属于哪个 filesystem
```

尤其一个集群存在多个 CephFS 时更清楚。

真正改变 damaged-rank 状态的是这个命令，但它仍然不等于“修复 metadata”。

## 什么情况下可以考虑清 damaged 标记

我会至少先满足下面这些条件：

```text
底层 OSD / PG 没有明显数据丢失
        +
metadata pool 没有 unresolved PG 问题
        +
已经检查 MDS 日志
        +
没有明确证据表明 journal / metadata 仍然损坏
        +
有回退或恢复方案
```

这时才考虑：

```bash
ceph mds repaired prod-fs:0
```

然后立刻观察：

```bash
watch -n 1 ceph fs status
```

另一个窗口：

```bash
watch -n 1 ceph health detail
```

如果 standby 能正常接管，可能会经历 replay、reconnect、rejoin 等状态，最后应该看到：

```text
rank 0 active
```

## `repaired` 以后要验证什么

不能只看：

```text
HEALTH_OK
```

### 1. CephFS 状态

```bash
ceph fs status
```

确认：

```text
rank 0 active
standby 数量正常
client 数量恢复
```

### 2. MDS Map

```bash
ceph mds stat
```

确保不再有：

```text
damaged
failed
```

rank。

### 3. Cluster Health

```bash
ceph health detail
```

确认：

```text
MDS_DAMAGE
MDS_ALL_DOWN
FS_DEGRADED
```

都已经消失。

### 4. 客户端实际 IO

从真实挂载 CephFS 的客户端做一个小的读写测试：

```bash
cd /mnt/cephfs
touch .cephfs-recovery-test
echo ok > .cephfs-recovery-test
cat .cephfs-recovery-test
rm -f .cephfs-recovery-test
```

不要只验证：

```text
MDS active
```

还要确认真实 metadata 操作和文件 IO 正常。

### 5. 再看 MDS 日志

恢复后继续观察一段时间。

如果很快再次出现：

```text
MDS_DAMAGE
```

说明刚才只是把 damaged 标记清掉，真正的问题还在。

这时不要反复执行：

```bash
ceph mds repaired
```

应该停下来处理 metadata damage。

## 如果 `repaired` 后又马上 damaged

这是最重要的分界点。

如果：

```text
repaired
        ↓
standby 接管
        ↓
马上又 damaged
```

说明 underlying metadata problem 还没有解决。

这时继续：

```text
repaired
repaired
repaired
```

没有意义。

需要根据日志和损坏类型进入：

```text
CephFS scrub / repair
journal recovery
metadata table recovery
cephfs-journal-tool
cephfs-data-scan
```

这一类工具有破坏性。

没有备份和明确判断时，不应该直接执行 metadata reconstruction。

Ceph 官方也明确警告：高级 metadata repair 工具如果使用不当，可能进一步损坏文件系统。

## `PG active+clean` 为什么还可能 MDS damaged

这个概念很容易混在一起。

```text
PG active+clean
```

主要告诉我们：

```text
RADOS 副本状态正常
对象 PG 当前可用
```

而：

```text
MDS damaged
```

可能来自：

```text
metadata 逻辑不一致
journal replay 问题
缺失或损坏的 metadata object
软件 bug
历史故障留下的不一致
```

所以：

```text
存储对象层正常
```

和：

```text
CephFS metadata 逻辑完全正常
```

不是同一个检查。

CephFS 排障不能只盯：

```bash
ceph -s
ceph osd tree
ceph pg stat
```

还要继续看：

```bash
ceph fs status
ceph mds stat
ceph fs dump
MDS logs
```

## 我现在会按这个顺序排查

以后再碰到：

```text
FS_DEGRADED
MDS_ALL_DOWN
MDS_DAMAGE
```

我会按这个顺序：

```text
1. ceph status
        ↓
2. ceph health detail
        ↓
3. ceph fs status
        ↓
4. ceph mds stat
        ↓
5. ceph fs dump
        ↓
6. 确认 metadata pool / PG 状态
        ↓
7. 查 MDS 日志，找第一次 damaged 的原因
        ↓
8. 判断是局部 damage
   还是 journal / metadata table 损坏
        ↓
9. 修复 underlying problem
        ↓
10. ceph mds repaired <fs>:<rank>
        ↓
11. 等 standby 接管
        ↓
12. health + client IO 验证
```

这样比：

```text
MDS 挂了
→ fail 两个 daemon
→ repaired
```

更容易知道每一步为什么做。

## 这次故障真正让我记住的三件事

第一：

> 有 standby MDS，不代表 damaged rank 一定能够自动 failover。

standby 能接普通 failed rank，但 damaged rank 必须先解决 damaged 状态。

第二：

> `ceph mds repaired` 这个名字很容易误导。

它没有帮你修 metadata。

它只是告诉 Monitor：

```text
我认为这个 rank 已经可以重新尝试启动了
```

第三：

> `HEALTH_OK` 是恢复成功的重要信号，但不是唯一验证。

我还会继续确认：

```text
MDS active
standby 正常
client reconnect
文件读写正常
MDS 日志没有再次报 damage
```

做到这里，这次 CephFS 恢复才算真正结束。

## 版本说明

原现场是：

```text
Ceph 16.2.5 Pacific
```

Pacific 后续还有多个维护版本。

故障恢复期间，我不会把：

```text
修 MDS
```

和：

```text
升级整个 Ceph 集群
```

混在一次变更里。

先恢复业务、确认文件系统稳定，再单独安排版本升级，风险更容易控制。

## References

- CephFS health messages  
  https://docs.ceph.com/en/pacific/cephfs/health-messages/
- CephFS administration — MDS commands  
  https://docs.ceph.com/en/pacific/cephfs/administration/
- CephFS disaster recovery  
  https://docs.ceph.com/en/pacific/cephfs/disaster-recovery/
- CephFS advanced metadata repair tools  
  https://docs.ceph.com/en/pacific/cephfs/disaster-recovery-experts/
