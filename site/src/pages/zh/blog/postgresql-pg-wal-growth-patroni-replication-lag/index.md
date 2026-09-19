---
layout: ../../../../layouts/ArticleLayout.astro
title: "PostgreSQL pg_wal 一直增长：Patroni 副本落后 230GB 时该怎么排查"
description: "从一组 Patroni 集群状态出发，解释 PostgreSQL WAL 为什么不会被回收，如何区分复制延迟、Replication Slot、归档失败和 wal_keep_size，并给出一套可直接执行的排查顺序。"
pubDate: "2026-09-19"
category: Databases
tags:
  - PostgreSQL
  - Patroni
  - WAL
  - Replication
  - Troubleshooting
enPath: "/blog/postgresql-pg-wal-growth-patroni-replication-lag/"
zhPath: "/zh/blog/postgresql-pg-wal-growth-patroni-replication-lag/"
---

这篇来自一份以前留下来的排障记录。

当时的问题是 PostgreSQL 的 `pg_wal` 一直增长。我只知道 Patroni 里有一个 Replica 落后得非常多，另一个 Replica 还在重建，但并没有真正搞明白：

```text
副本延迟很大
        ↓
为什么主库的 pg_wal 就会越积越多？
```

后来把 WAL 的回收条件、Replication Slot 和 Patroni 的状态拆开看，这件事才顺起来。

先放当时类似的状态。集群名、IP 和节点名已经换成通用值：

```bash
patronictl list
```

```text
+ Cluster: prod-pg ------------------------------+----+-----------+
| Member    | Host       | Role    | State            | TL | Lag in MB |
+-----------+------------+---------+------------------+----+-----------+
| prod-pg-0 | 10.20.0.11 | Replica | running          |  5 |    235000 |
| prod-pg-1 | 10.20.0.12 | Leader  | running          | 15 |           |
| prod-pg-2 | 10.20.0.13 | Replica | creating replica |    |   unknown |
+-----------+------------+---------+------------------+----+-----------+
```

这里最醒目的其实不是 `creating replica`，而是：

```text
prod-pg-0
TL = 5
Lag ≈ 235000 MB
```

而 Leader 已经是：

```text
TL = 15
```

235000 MB 大约就是 230 GiB。

这已经不是“稍微有点复制延迟”了。

但有一点要先说明：

> 仅凭 `patronictl list`，还不能直接下结论说“就是这个 Replica 导致 pg_wal 增长”。

它只是一个非常强的线索。真正要确认 WAL 为什么没有被回收，还得继续看 Replication Slot、归档和 WAL 保留参数。

## 先把 WAL 想明白

PostgreSQL 的 WAL 不是普通意义上的应用日志。

数据库里的修改会先记录到 WAL，再落到数据文件。WAL 同时还用于：

- 崩溃恢复；
- Streaming Replication；
- PITR；
- WAL Archive。

文件在：

```text
$PGDATA/pg_wal/
```

正常情况下，旧 WAL 不会无限增长。

当 checkpoint 之后，PostgreSQL 确认某些旧 WAL 已经没人再需要，就可以把它们删除或者循环复用。

所以当 `pg_wal` 长期只增不减时，我现在首先想到的不是：

```text
是不是 max_wal_size 太小？
```

而是：

> **是谁还在告诉 PostgreSQL：“这个旧 WAL 我还要，不能删。”**

最常见的几个原因是：

```text
Replication Slot
Archive 失败
wal_keep_size
落后或失联的 Replica
```

其中 Replica 本身并不会神奇地“锁住 WAL”。

真正让旧 WAL 保留下来的，通常是和 Replica 配套使用的 **Replication Slot**，或者其他明确的保留机制。

## `max_wal_size` 不是 pg_wal 的硬上限

例如：

```text
max_wal_size = 4GB
```

并不等于：

```text
pg_wal 永远不会超过 4GB
```

`max_wal_size` 主要影响 checkpoint 行为。

如果旧 WAL 仍然被 Replication Slot、归档流程或 `wal_keep_size` 需要，那么 PostgreSQL 不能因为超过 `max_wal_size` 就直接删掉它们。

所以现场如果已经有几十 GB、甚至几百 GB WAL，单纯把 `max_wal_size` 改小，解决不了保留链路的问题。

## 这份 Patroni 输出到底告诉了什么

### Leader 本身还在运行

```text
prod-pg-1
Role  = Leader
State = running
TL    = 15
```

至少 Patroni 认为当前 Leader 正常运行。

但这不代表 HA 状态健康。

### 一个 Replica 落后约 230 GiB

```text
prod-pg-0
Lag in MB = 235000
```

Patroni 的 `Lag in MB` 表示这个 member 和它上游之间大约差了多少 WAL。

它不是：

```text
网络延迟 235000 MB
```

也不能简单理解成：

```text
数据库已经损坏
```

更准确地说，是这个 Replica 的 WAL 位置和上游相差了大约 230 GiB。

这个 Replica 在自己的 replay 位置上仍然可能是一致的，只是非常旧。

### Timeline 也明显不一致

Leader：

```text
TL = 15
```

Replica：

```text
TL = 5
```

Patroni 里的 `TL` 是 PostgreSQL Timeline。

发生 Promotion 时，PostgreSQL 会进入新的 Timeline。

所以一个 Replica 还停在 Timeline 5，而当前 Leader 已经在 Timeline 15，说明它至少没有正常跟到当前 Leader 的时间线。

配合 230 GiB Lag 看，这已经应该被当成异常副本重点排查，而不是普通网络抖动。

可以看看 Patroni 的 failover / switchover 历史：

```bash
patronictl history prod-pg
```

### 另一个 Replica 正在创建

```text
prod-pg-2
State = creating replica
```

这说明 Patroni 正在构建这个 standby。

默认情况下 Patroni 可以使用 `pg_basebackup` 创建新的 Replica，也可以按配置使用其他 clone 方法。

当时的整体状态更像：

```text
Leader
  ├── Replica A：严重落后，而且 Timeline 很旧
  └── Replica B：正在重建
```

Leader 虽然还在工作，但冗余状态已经不好。

## 最关键的一步：查 Replication Slot

如果今天再看到这组状态，我第一批 SQL 里一定会有：

```sql
SELECT
    slot_name,
    slot_type,
    active,
    restart_lsn,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
    ) AS retained_wal
FROM pg_replication_slots
ORDER BY
    pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
```

重点看：

```text
slot_name
active
restart_lsn
retained_wal
```

假设结果类似：

```text
slot_name   | active | retained_wal
------------+--------+-------------
prod_pg_0   | f      | 228 GB
prod_pg_2   | t      | 3 GB
```

那事情基本就串起来了：

```text
prod-pg-0 很久没有推进
        ↓
它对应的 physical replication slot
restart_lsn 也停在很早的位置
        ↓
Primary 认为这些旧 WAL 以后还可能被这个 Replica 使用
        ↓
不能回收
        ↓
pg_wal 越积越多
```

Slot 本来是为了防止 Replica 临时掉线以后，Primary 把它还没收到的 WAL 删除。

但如果 Replica 长时间坏掉，而 Slot 一直保留，它也会反过来让 Primary 一直保存旧 WAL。

## `restart_lsn` 是什么

例如：

```text
当前 Primary WAL 位置
0/90000000

某个 Slot restart_lsn
0/10000000
```

中间这段 WAL 对这个 Slot 来说仍可能是必需的。

可以用：

```sql
pg_wal_lsn_diff(
    pg_current_wal_lsn(),
    restart_lsn
)
```

计算距离，结果单位是 byte。

再套：

```sql
pg_size_pretty(...)
```

就能直接看到：

```text
28 GB
120 GB
230 GB
```

这比只看目录里“有很多 WAL 文件”更容易找到是谁在留 WAL。

## 如果版本支持，再看 `wal_status`

较新的 PostgreSQL 版本在 `pg_replication_slots` 里还有：

```text
wal_status
```

可以查：

```sql
SELECT
    slot_name,
    active,
    restart_lsn,
    wal_status,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
    ) AS retained_wal
FROM pg_replication_slots;
```

常见状态包括：

```text
reserved
extended
unreserved
lost
```

看到 `extended`，通常意味着 Slot 或 `wal_keep_size` 正在让 WAL 保留量超过 `max_wal_size`。

如果版本不支持这个字段，查基础的：

```text
slot_name
active
restart_lsn
```

已经足够开始判断。

## `max_slot_wal_keep_size` 很重要

支持这个参数的 PostgreSQL 版本可以查看：

```sql
SHOW max_slot_wal_keep_size;
```

如果是：

```text
-1
```

表示 replication slot 可以不受这个参数限制地保留 WAL。

这对于临时掉线的 Replica 很友好。

但如果 Replica 长期故障：

```text
Replica 不前进
+
Slot 不前进
=
pg_wal 可以一直增长
```

可以给 `max_slot_wal_keep_size` 设置上限，但这不是免费的保护。

一旦旧 WAL 被允许删除，而 Replica 之后还想从原来的 `restart_lsn` 接着追，可能会因为缺失 WAL 而只能重新初始化。

所以这个参数是在：

```text
保护 Primary 磁盘
```

和：

```text
尽量允许旧 Replica 原地追上
```

之间做取舍。

## 原记录里的 SQL 有个问题

原来的记录里有：

```sql
SELECT
    pg_current_wal_lsn(),
    pg_last_wal_receive_lsn(),
    pg_last_wal_replay_lsn()
FROM pg_stat_replication;
```

这个写法把 Primary 和 Standby 两个视角混在了一起。

`pg_current_wal_lsn()` 通常用于看 Primary 当前 WAL 位置。

而：

```text
pg_last_wal_receive_lsn()
pg_last_wal_replay_lsn()
```

更适合在 Standby 本机查看。

### Primary 上看 `pg_stat_replication`

我更习惯这样：

```sql
SELECT
    application_name,
    client_addr,
    state,
    sync_state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
    ) AS replay_lag_bytes,
    write_lag,
    flush_lag,
    replay_lag
FROM pg_stat_replication
ORDER BY application_name;
```

这能看出每条 WAL Sender 连接：

```text
已经发送到哪
Replica 写到哪
flush 到哪
replay 到哪
```

其中 `pg_wal_lsn_diff()` 算的是 **WAL 字节差**。

而：

```text
write_lag
flush_lag
replay_lag
```

是时间维度的统计。

这两个概念不要混在一起。

## 在 Replica 上看 receive 和 replay

如果能进入 Replica，可以执行：

```sql
SELECT
    pg_is_in_recovery(),
    pg_last_wal_receive_lsn(),
    pg_last_wal_replay_lsn(),
    pg_size_pretty(
        pg_wal_lsn_diff(
            pg_last_wal_receive_lsn(),
            pg_last_wal_replay_lsn()
        )
    ) AS receive_replay_gap,
    now() - pg_last_xact_replay_timestamp() AS replay_delay;
```

这里能分出两种情况。

第一种：

```text
receive LSN 自己都不怎么动
```

那就去查：

```text
网络
WAL Sender
认证
Slot
Patroni / PostgreSQL 日志
```

第二种：

```text
receive LSN 前进很快
replay LSN 明显落后
```

说明 WAL 已经收到，但本地 replay 跟不上。

这时更应该查 Replica 自己的：

```text
磁盘 IO
CPU
长查询
recovery conflict
资源限制
```

所以一句“Replica 延迟很大”还不够。

要继续拆成：

```text
没收到
还是
收到了但没 replay
```

## Replication Slot 不是唯一原因，还要查 Archive

另一个会让 `pg_wal` 一直堆积的典型原因是：

```text
archive_command 一直失败
```

先看：

```sql
SHOW archive_mode;
SHOW archive_command;
```

再看：

```sql
SELECT
    archived_count,
    failed_count,
    last_archived_wal,
    last_archived_time,
    last_failed_wal,
    last_failed_time
FROM pg_stat_archiver;
```

如果：

```text
failed_count 一直增加
last_failed_time 很新
last_archived_time 很久没变化
```

就要去查 archive 目标、权限、网络、脚本和磁盘。

归档没完成的 WAL 也不能正常回收，结果同样可能是：

```text
pg_wal 一直涨
```

## 再看几个 WAL 配置

我会顺手确认：

```sql
SHOW max_wal_size;
SHOW min_wal_size;
SHOW wal_keep_size;
SHOW archive_mode;
SHOW max_slot_wal_keep_size;
```

最后一个参数如果版本太旧可能不存在。

这里最容易犯的错误是看到 `pg_wal` 很大以后直接开始调：

```text
wal_level
max_wal_senders
wal_buffers
```

这些不是这类问题的第一排查方向。

`max_wal_senders` 控制 WAL Sender 的数量。

`wal_buffers` 是生成 WAL 时使用的共享内存缓冲。

它们都不能直接解释：

```text
为什么几十 GB 旧 WAL 一直没有被回收
```

先把保留 WAL 的人找到更重要。

## `wal_keep_size` 也会保留 WAL

如果：

```sql
SHOW wal_keep_size;
```

得到一个非常大的值，也会让 PostgreSQL 至少保留这么多近期 WAL。

不过和 replication slot 有个区别：

```text
wal_keep_size
```

主要是配置一个保留量。

而 Slot 会跟着某个 Consumer 的 LSN 进度走。

所以碰到某个 Replica 正好落后 200 多 GB，而某个 Slot 的 `retained_wal` 也接近 200 多 GB，这个关联就很强。

## Patroni 环境不要随便手工删 Slot

如果 Patroni 配置了：

```text
use_slots
```

它会参与管理 replication slots。

可以先看动态配置：

```bash
patronictl show-config prod-pg
```

再结合：

```sql
SELECT * FROM pg_replication_slots;
```

确认每个 Slot 到底是谁的。

不要看到：

```text
active = false
```

就马上执行：

```sql
SELECT pg_drop_replication_slot(...);
```

因为 `active=false` 只能说明此刻没有 Consumer 正在使用。

它不等于：

```text
这个 Slot 一定没用了
```

而且 Patroni 管理的 Slot 还可能被重新创建。

## 什么时候考虑 `patronictl reinit`

回到最开始：

```text
Replica A:
TL 5
Lag ≈ 230 GiB

Leader:
TL 15

Replica B:
creating replica
```

如果 Replica A：

- 很长时间追不上；
- Patroni / PostgreSQL 日志持续报恢复失败；
- 需要的 WAL 已经不存在；
- 或 Timeline 已经分叉且不能正常恢复；

那继续等它慢慢追不一定有意义。

Patroni 提供：

```bash
patronictl reinit prod-pg prod-pg-0
```

用于重建 Replica。

但是这会重建 standby，不应该因为 Lag 大就直接执行。

尤其现场还有：

```text
prod-pg-2 = creating replica
```

这时候如果 `prod-pg-0` 也马上 reinit，短时间内两个 Replica 都不可用。

我会先保证至少有一个健康 Replica，或者确认备份和恢复方案没问题，再处理另一个。

## `creating replica` 长时间不结束怎么办

如果 member 长时间停在：

```text
creating replica
```

应该看这个 member 的 Patroni 日志。

默认 `pg_basebackup` 场景还要关注：

```text
网络速度
Primary IO
Replica 磁盘写入
pg_basebackup 是否持续有进度
```

Patroni 的状态只是在告诉你：

```text
它正在创建
```

并没有告诉你：

```text
为什么创建了这么久
```

## 磁盘快满时最重要的一条

不要直接：

```bash
rm -f "$PGDATA/pg_wal/"*
```

`pg_wal` 是 PostgreSQL 恢复和复制状态的一部分，不是普通日志目录。

手工删 WAL 可能让：

```text
实例无法恢复
Replica 断档
数据库无法启动
```

如果磁盘已经非常危险，我宁愿先：

```text
临时扩容
清理同盘无关文件
降低业务写入量
```

先买一点处理时间。

然后再把真正阻止 WAL 回收的原因处理掉。

## 我现在会按什么顺序查

### 1. 看 pg_wal 到底多大

```bash
du -sh "$PGDATA/pg_wal"
```

文件数量：

```bash
find "$PGDATA/pg_wal" -maxdepth 1 -type f | wc -l
```

### 2. 看 Patroni 状态

```bash
patronictl list
patronictl history prod-pg
```

重点看：

```text
Role
State
TL
Lag in MB
```

### 3. 在 Leader 看 `pg_stat_replication`

```sql
SELECT
    application_name,
    client_addr,
    state,
    sync_state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
    ) AS replay_lag_bytes
FROM pg_stat_replication;
```

### 4. 查 Replication Slot

```sql
SELECT
    slot_name,
    slot_type,
    active,
    restart_lsn,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
    ) AS retained_wal
FROM pg_replication_slots;
```

这一步经常直接把问题指出来。

### 5. 查 Archive

```sql
SELECT
    archived_count,
    failed_count,
    last_archived_wal,
    last_archived_time,
    last_failed_wal,
    last_failed_time
FROM pg_stat_archiver;
```

### 6. 查配置

```sql
SHOW max_wal_size;
SHOW wal_keep_size;
SHOW archive_mode;
SHOW max_slot_wal_keep_size;
```

### 7. 再决定下一步

```text
Replica 能继续追
→ 修网络 / IO / replication

Replica 已经不值得救
→ reinit

Slot 对应的是废弃 consumer
→ 在确认 Patroni 管理方式后处理 slot

Archive 挂了
→ 修 archive

wal_keep_size 配得异常大
→ 调整配置
```

而不是一上来就改 PostgreSQL 参数。

## 回头再看最初那组状态

现在再看：

```text
Replica A
TL = 5
Lag ≈ 230 GiB

Leader
TL = 15

Replica B
creating replica
```

我的理解会变成：

```text
一个 Replica 严重陈旧
        ↓
另一个 Replica 正在重建
        ↓
集群 HA 冗余下降
        ↓
如果陈旧 Replica 还有 physical slot
        ↓
它可能要求 Primary 保留大量旧 WAL
        ↓
pg_wal 持续膨胀
```

注意里面那个：

```text
如果
```

很重要。

`patronictl list` 给出了方向，但是否真的是 Slot 在留 WAL，需要 `pg_replication_slots` 来证实。

如果 Slot 没问题，再去检查 archive 和其他 WAL 保留条件。

## 最后记住三个点

第一：

> Replica Lag 很大，不等于数据库“数据损坏”，而是这个 Replica 离 Primary 当前 WAL 位置非常远。

第二：

> Replication Slot 能保护掉线 Replica，但坏掉的 Replica加上长期保留的 Slot，也可能把 Primary 的 `pg_wal` 撑满。

第三：

> `pg_wal` 不是可以手工清理的日志目录。先找出为什么 PostgreSQL 不肯回收 WAL，再处理对应的 Replica、Slot 或 Archive。

理解这三件事以后，再碰到 WAL 暴涨，排查路径就不会乱了。

## References

- PostgreSQL — Streaming Replication and Replication Slots  
  https://www.postgresql.org/docs/current/warm-standby.html
- PostgreSQL — Replication configuration  
  https://www.postgresql.org/docs/current/runtime-config-replication.html
- PostgreSQL — `pg_replication_slots`  
  https://www.postgresql.org/docs/current/view-pg-replication-slots.html
- PostgreSQL — Monitoring `pg_stat_replication`  
  https://www.postgresql.org/docs/current/monitoring-stats.html
- PostgreSQL — Continuous Archiving and PITR  
  https://www.postgresql.org/docs/current/continuous-archiving.html
- Patroni — `patronictl`  
  https://patroni.readthedocs.io/en/latest/patronictl.html
- Patroni — Replica imaging and bootstrap  
  https://patroni.readthedocs.io/en/latest/replica_bootstrap.html
