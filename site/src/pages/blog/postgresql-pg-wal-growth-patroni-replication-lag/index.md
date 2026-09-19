---
layout: ../../../layouts/ArticleLayout.astro
title: "Why PostgreSQL pg_wal Keeps Growing: Patroni Replication Lag and Replication Slot Troubleshooting"
description: "A practical walkthrough of PostgreSQL WAL retention in a Patroni cluster: how to interpret a replica lagging by about 230 GiB, inspect replication slots, rule out archive failures, and decide whether a standby should catch up or be rebuilt."
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

This article started from an old troubleshooting note about a PostgreSQL `pg_wal` directory that kept growing.

At the time, I knew one Patroni replica was extremely far behind and another replica was being rebuilt, but I did not really understand the connection:

```text
large replica lag
        ↓
why would that make pg_wal keep growing?
```

The picture became much clearer after separating WAL recycling, replication slots, archiving, and Patroni state.

Here is an anonymized version of the original cluster state:

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

The interesting part is not only `creating replica`.

It is this:

```text
prod-pg-0
TL = 5
Lag ≈ 235000 MB
```

while the leader is already on:

```text
TL = 15
```

235000 MB is roughly 230 GiB.

That is not ordinary replication lag.

However, `patronictl list` alone is not enough to prove that this replica is the reason `pg_wal` is growing. It is a strong clue. The actual WAL retention mechanism still needs to be identified.

## A useful mental model for WAL

PostgreSQL WAL is not an application log that can simply be rotated or deleted.

Database changes are recorded in WAL before the corresponding data pages are written. WAL is also used for:

- crash recovery;
- streaming replication;
- point-in-time recovery;
- WAL archiving.

The files live under:

```text
$PGDATA/pg_wal/
```

Under normal conditions, old segments are eventually removed or recycled after checkpoints when PostgreSQL knows nothing still needs them.

So when `pg_wal` only grows and never comes back down, the first question is:

> **Who is still telling PostgreSQL that these old WAL segments are needed?**

Common answers include:

```text
replication slots
failed or delayed archiving
wal_keep_size
a lagging or disconnected replica using a slot
```

A slow replica by itself does not magically pin WAL forever. A retention mechanism such as a replication slot is usually what turns replica lag into large WAL retention.

## `max_wal_size` is not a hard pg_wal limit

If:

```text
max_wal_size = 4GB
```

that does not mean:

```text
pg_wal can never exceed 4GB
```

`max_wal_size` influences checkpoint behavior.

If older WAL is still required by a replication slot, WAL archiving, or `wal_keep_size`, PostgreSQL cannot safely remove it simply because `max_wal_size` has been exceeded.

That is why reducing `max_wal_size` is not a fix for a server retaining tens or hundreds of gigabytes of required WAL.

## Reading the Patroni output

### The leader is running

```text
prod-pg-1
Role  = Leader
State = running
TL    = 15
```

Patroni considers the current primary up.

That does not mean the HA topology is healthy.

### One replica is roughly 230 GiB behind

```text
prod-pg-0
Lag in MB = 235000
```

Patroni's lag value represents the amount of WAL distance between the member and its upstream.

It is not a network latency measurement.

It also does not automatically mean that the replica database is corrupt. The replica may still be internally consistent at its current replay point; it is simply very stale.

### The timelines are far apart

The leader is on:

```text
TL = 15
```

while the replica reports:

```text
TL = 5
```

`TL` is the PostgreSQL timeline.

Promotions normally create new timelines. A replica still showing timeline 5 while the current leader is on timeline 15 deserves investigation, especially when combined with hundreds of gigabytes of lag.

Patroni can show failover and switchover history:

```bash
patronictl history prod-pg
```

### The second replica is being rebuilt

```text
prod-pg-2
State = creating replica
```

Patroni is building the standby.

By default Patroni can use `pg_basebackup`, although other clone methods can be configured.

At that moment the topology is effectively:

```text
Leader
  ├── Replica A: extremely stale
  └── Replica B: being rebuilt
```

The leader may be serving traffic, but replica redundancy is degraded.

## The most important check: replication slots

If I saw this cluster today, one of my first queries on the primary would be:

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

The fields I care about are:

```text
slot_name
active
restart_lsn
retained_wal
```

Imagine the result is:

```text
slot_name   | active | retained_wal
------------+--------+-------------
prod_pg_0   | f      | 228 GB
prod_pg_2   | t      | 3 GB
```

Now the story fits:

```text
prod-pg-0 stopped advancing
        ↓
its physical replication slot stopped advancing too
        ↓
the primary still considers old WAL necessary
        ↓
old WAL cannot be recycled
        ↓
pg_wal keeps growing
```

Slots protect a replica from losing required WAL during a temporary outage. But an abandoned replica paired with a retained slot can eventually consume all available `pg_wal` disk space.

## What `restart_lsn` means

Suppose the primary is currently at:

```text
0/90000000
```

and a slot has:

```text
restart_lsn = 0/10000000
```

The WAL between those locations may still be required by that slot.

The distance can be measured with:

```sql
pg_wal_lsn_diff(
    pg_current_wal_lsn(),
    restart_lsn
)
```

The result is in bytes.

Wrapping it with:

```sql
pg_size_pretty(...)
```

gives a much more useful value such as:

```text
28 GB
120 GB
230 GB
```

That often identifies the WAL consumer immediately.

## `wal_status` can provide another clue

On PostgreSQL versions that expose it, `pg_replication_slots` includes:

```text
wal_status
```

For example:

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

Possible states include:

```text
reserved
extended
unreserved
lost
```

`extended` means WAL retention has gone beyond `max_wal_size` because the WAL is still being kept by a slot or by `wal_keep_size`.

On older versions, the basic fields are still enough to start:

```text
slot_name
active
restart_lsn
```

## `max_slot_wal_keep_size`

On PostgreSQL versions that support it:

```sql
SHOW max_slot_wal_keep_size;
```

A value of:

```text
-1
```

means replication slots are not limited by this setting and may retain an unlimited amount of WAL.

That is good for a replica that should be allowed to catch up after an outage.

It is risky when the replica remains broken for a long time.

A limit can protect the primary's disk, but there is a trade-off: once required WAL is removed, an old standby may no longer be able to continue from its previous `restart_lsn` and may need to be rebuilt.

## Inspect actual streaming replication on the primary

The original note mixed:

```text
pg_current_wal_lsn()
pg_last_wal_receive_lsn()
pg_last_wal_replay_lsn()
```

with `pg_stat_replication`.

That mixes primary-side and standby-side perspectives.

On the primary, I would use:

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

This shows each WAL sender connection and how far the standby has progressed through:

```text
sent
written
flushed
replayed
```

`pg_wal_lsn_diff()` measures WAL distance in bytes.

The `write_lag`, `flush_lag`, and `replay_lag` columns are time-based measurements.

Those are different dimensions.

## Inspect receive and replay on a replica

On the standby itself:

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

This helps distinguish two failures.

If:

```text
receive LSN barely advances
```

look at:

```text
network
WAL sender
authentication
replication slot
Patroni and PostgreSQL logs
```

If:

```text
receive LSN advances
but replay LSN is far behind
```

WAL is arriving but local replay cannot keep up.

Then investigate the standby's:

```text
disk I/O
CPU
long-running queries
recovery conflicts
resource limits
```

So "replica lag is huge" should be broken into:

```text
not receiving
or
receiving but not replaying
```

## Replication slots are not the only cause

Failed WAL archiving can create the same symptom.

Check:

```sql
SHOW archive_mode;
SHOW archive_command;
```

and:

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

If `failed_count` keeps rising and `last_archived_time` stops moving, investigate the archive destination, permissions, network, scripts, and storage.

PostgreSQL retains WAL that has not been archived successfully.

The result can again be:

```text
pg_wal keeps growing
```

## Check the main WAL retention settings

I also review:

```sql
SHOW max_wal_size;
SHOW min_wal_size;
SHOW wal_keep_size;
SHOW archive_mode;
SHOW max_slot_wal_keep_size;
```

The last parameter may not exist on older PostgreSQL releases.

It is tempting to start tuning:

```text
wal_level
max_wal_senders
wal_buffers
```

but those are not the first knobs for this symptom.

`max_wal_senders` controls how many WAL sender connections can exist.

`wal_buffers` controls shared memory used while WAL is being generated.

Neither explains why tens or hundreds of gigabytes of old WAL remain unrecycled.

## `wal_keep_size` also retains WAL

A very large:

```sql
SHOW wal_keep_size;
```

value will deliberately keep recent WAL on the primary.

The difference is that `wal_keep_size` is primarily a configured retention amount, while a replication slot tracks a consumer's progress.

If a replica is about 230 GiB behind and one slot reports roughly the same amount of `retained_wal`, that correlation is much stronger evidence than `wal_keep_size` alone.

## Patroni-managed slots need extra care

If Patroni is configured with:

```text
use_slots
```

it participates in managing replication slots.

Check dynamic configuration:

```bash
patronictl show-config prod-pg
```

and compare it with:

```sql
SELECT * FROM pg_replication_slots;
```

Do not drop a slot merely because:

```text
active = false
```

That only means no consumer is currently using it.

It does not mean the slot is obsolete.

Patroni may also recreate slots that it manages.

## When to consider `patronictl reinit`

Return to the original situation:

```text
Replica A:
TL 5
Lag ≈ 230 GiB

Leader:
TL 15

Replica B:
creating replica
```

If Replica A:

- remains unable to catch up;
- repeatedly fails recovery;
- has already lost required WAL;
- or has diverged in a way Patroni cannot recover;

waiting indefinitely may not be useful.

Patroni provides:

```bash
patronictl reinit prod-pg prod-pg-0
```

to rebuild a standby.

This is a destructive operation for that replica's local data directory and should not be triggered merely because the lag number is large.

In this example another replica is already being rebuilt. Reinitializing the old replica immediately would leave both standbys unavailable at the same time.

I would first make sure another replica is healthy, or that backup and recovery are in good shape, before rebuilding the remaining standby.

## If `creating replica` never finishes

A member staying in:

```text
creating replica
```

for a long time needs more than another `patronictl list`.

Check the Patroni logs on that member.

For a default `pg_basebackup` build, also check:

```text
network throughput
primary I/O
replica disk write performance
whether pg_basebackup is actually progressing
```

The status says Patroni is creating a replica. It does not explain why the operation is slow or stuck.

## Never manually delete files from pg_wal

Do not solve a disk emergency with:

```bash
rm -f "$PGDATA/pg_wal/"*
```

`pg_wal` is part of PostgreSQL's recovery and replication state.

Deleting segments manually can leave replicas unable to recover or make a database fail to start.

If the filesystem is almost full, it is safer to buy time by:

```text
temporarily expanding the volume
cleaning unrelated files from the same filesystem
reducing write load
```

and then fix the actual WAL retention cause.

## The troubleshooting order I use now

### 1. Measure pg_wal

```bash
du -sh "$PGDATA/pg_wal"
```

Count files:

```bash
find "$PGDATA/pg_wal" -maxdepth 1 -type f | wc -l
```

### 2. Check Patroni

```bash
patronictl list
patronictl history prod-pg
```

Pay attention to:

```text
Role
State
TL
Lag in MB
```

### 3. Check streaming replication on the leader

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

### 4. Check replication slots

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

This query often points directly at the consumer retaining WAL.

### 5. Check archiving

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

### 6. Check settings

```sql
SHOW max_wal_size;
SHOW wal_keep_size;
SHOW archive_mode;
SHOW max_slot_wal_keep_size;
```

### 7. Only then decide what to fix

The next action should follow the evidence:

```text
replica can catch up
→ fix network / I/O / replication

replica is no longer recoverable
→ rebuild it

slot belongs to a retired consumer
→ handle it after checking Patroni slot management

archiving is failing
→ repair archiving

wal_keep_size is unexpectedly huge
→ adjust configuration
```

## Re-reading the original cluster state

The original output now tells a much clearer story:

```text
one replica is severely stale
        ↓
another replica is being rebuilt
        ↓
HA redundancy is degraded
        ↓
if the stale replica still owns a physical slot
        ↓
the primary may retain a very large amount of old WAL
        ↓
pg_wal keeps growing
```

The word **if** matters.

`patronictl list` points to the problem area. `pg_replication_slots` proves whether that replica is actually pinning WAL.

If the slots look healthy, move on to archiving and the other WAL retention conditions.

## Three things I remember from this incident

First:

> A large replica lag does not mean the standby is corrupt. It means the standby is far behind the primary's current WAL position.

Second:

> Replication slots protect disconnected replicas, but a broken replica combined with a retained slot can fill the primary's `pg_wal` filesystem.

Third:

> `pg_wal` is not a log directory that should be cleaned by hand. Find the reason PostgreSQL refuses to recycle WAL, then fix the replica, slot, archive, or retention setting responsible for it.

Once those three ideas are clear, WAL growth becomes much easier to troubleshoot.

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
