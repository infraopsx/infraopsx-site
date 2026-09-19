---
layout: ../../../layouts/ArticleLayout.astro
title: "Troubleshooting etcd NOSPACE: Quota, Compaction, Defragmentation, and Alarm Recovery"
description: "A practical guide to etcd NOSPACE alarms: how to inspect backend size, compact old revisions, defragment members, clear the alarm, and decide whether --quota-backend-bytes really needs to be increased."
pubDate: "2026-09-19"
category: Databases
tags:
  - etcd
  - Troubleshooting
  - Storage
  - Kubernetes
enPath: "/blog/etcd-nospace-alarm-troubleshooting/"
zhPath: "/zh/blog/etcd-nospace-alarm-troubleshooting/"
---

When etcd raises `NOSPACE`, the first reaction is often:

```text
The default quota is only 2 GiB. Why not just increase it to 8 GiB?
```

That can be part of the fix, but it is usually not the whole fix.

A `NOSPACE` alarm is a signal that the etcd backend has reached or exceeded its configured space quota. Before changing the quota, I want to know whether the space is occupied by active data, old MVCC revisions, or free pages that have not been returned to the filesystem.

## What NOSPACE means

The default etcd backend storage quota is **2 GiB**.

It can be changed with:

```text
--quota-backend-bytes
```

The etcd documentation suggests **8 GiB** as the maximum for normal environments. Values above that produce a startup warning.

8 GiB in bytes is:

```text
8589934592
```

For example:

```bash
etcd --quota-backend-bytes=8589934592
```

or:

```bash
ETCD_QUOTA_BACKEND_BYTES=8589934592
```

But 8 GiB is a suggested maximum, not a value that should automatically be applied whenever `NOSPACE` appears.

If the backend grew because of old revisions or internal fragmentation, increasing the quota only postpones the next alarm.

## What happens when the quota is exceeded

When the backend database of a member exceeds the quota, etcd raises a cluster-wide `NOSPACE` alarm.

A client may see:

```text
rpc error: code = 8 desc = etcdserver: mvcc: database space exceeded
```

Check the alarms first:

```bash
etcdctl alarm list
```

Typical output:

```text
memberID:xxxxxxxxxxxxxxxx alarm:NOSPACE
```

Do not immediately run:

```bash
etcdctl alarm disarm
```

The alarm is the symptom. If the backend is still above quota, clearing the alarm does not fix the storage problem.

## Check backend size per member

Start with:

```bash
etcdctl endpoint status --cluster -w table
```

The important column is:

```text
DB SIZE
```

For a TLS-enabled cluster, use the normal endpoints and certificate options.

For example:

```bash
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://etcd-0.example:2379,https://etcd-1.example:2379,https://etcd-2.example:2379"

etcdctl endpoint status --cluster -w table
etcdctl alarm list
```

If etcd runs on Kubernetes, the same checks can be run from one member Pod:

```bash
kubectl -n etcd-system exec -it etcd-0 -- \
  etcdctl endpoint status --cluster -w table
```

The exact namespace, certificates and endpoints depend on the cluster.

## A large DB file does not always mean that much live data exists

etcd uses MVCC and keeps historical revisions of keys.

A key that changes repeatedly:

```text
foo = v1
foo = v2
foo = v3
foo = v4
...
```

may look like one key to the application while multiple historical revisions still occupy backend space.

There is another detail: even after old revisions are removed, the backend file itself does not automatically shrink.

That is why compaction and defragmentation are separate operations.

## What compaction does

Compaction removes old keyspace revisions.

One way to obtain the current revision is:

```bash
rev=$(
  etcdctl endpoint status --write-out=json \
  | grep -o '"revision":[0-9]*' \
  | head -1 \
  | cut -d: -f2
)

echo "$rev"
```

After checking the value:

```bash
etcdctl compact "$rev"
```

For example:

```text
compacted revision 1516
```

After compaction, revisions older than the selected revision are no longer available.

This is not a harmless cache cleanup. If applications depend on historical revisions or watch replay, choose the retention policy deliberately.

etcd also supports automatic compaction.

Time-based retention:

```bash
etcd --auto-compaction-mode=periodic \
     --auto-compaction-retention=10h
```

Revision-based retention:

```bash
etcd --auto-compaction-mode=revision \
     --auto-compaction-retention=1000
```

There is no single retention value that fits every workload.

## Why the file may still be large after compaction

Compaction makes old pages reusable inside the backend, but it does not necessarily return those pages to the filesystem.

The sequence is roughly:

```text
compact
  ↓
old revisions are removed
  ↓
free pages appear inside the backend
  ↓
the backend file may still remain large
```

To return that free space to the filesystem, the backend must be defragmented.

## Defragment members

For one member:

```bash
etcdctl --endpoints=https://etcd-0.example:2379 defrag
```

Then repeat for the other members.

etcd also supports:

```bash
etcdctl defrag --cluster
```

Online defragmentation blocks reads and writes on the member while its backend is rebuilt, so in production I prefer to handle members one at a time and avoid peak traffic.

After each step, check:

```bash
etcdctl endpoint status --cluster -w table
```

and compare the backend sizes.

## The recovery sequence I use

When I see `NOSPACE`, I normally work through the problem in this order.

### 1. Confirm the alarm

```bash
etcdctl alarm list
```

Verify that `NOSPACE` is actually present.

### 2. Check endpoint status

```bash
etcdctl endpoint status --cluster -w table
```

Find the members closest to or already above quota.

### 3. Check the node filesystem too

An etcd quota alarm and a nearly full node filesystem are different problems, but they can happen at the same time.

```bash
df -h
df -i
```

On Kubernetes, I also check:

```bash
kubectl describe node <node>
```

for:

```text
DiskPressure
```

### 4. Take a snapshot before maintenance

If possible:

```bash
etcdctl snapshot save before-nospace-maintenance.db
```

Then verify it:

```bash
etcdutl --write-out=table \
  snapshot status before-nospace-maintenance.db
```

The snapshot does not clear `NOSPACE`; it simply provides a recovery point before modifying keyspace history and backend layout.

### 5. Compact old revisions

```bash
rev=$(
  etcdctl endpoint status --write-out=json \
  | grep -o '"revision":[0-9]*' \
  | head -1 \
  | cut -d: -f2
)

etcdctl compact "$rev"
```

### 6. Defragment members one by one

For example:

```bash
etcdctl --endpoints=https://etcd-0.example:2379 defrag
etcdctl --endpoints=https://etcd-1.example:2379 defrag
etcdctl --endpoints=https://etcd-2.example:2379 defrag
```

Use the normal TLS options if required.

### 7. Check backend size again

```bash
etcdctl endpoint status --cluster -w table
```

Make sure the backend has returned below quota.

### 8. Clear the alarm

Only then:

```bash
etcdctl alarm disarm
```

Verify:

```bash
etcdctl alarm list
```

### 9. Verify writes

Use a harmless test key:

```bash
etcdctl put /maintenance/nospace-test ok
etcdctl get /maintenance/nospace-test
etcdctl del /maintenance/nospace-test
```

At that point the recovery is actually complete.

## When increasing the quota makes sense

If compaction and defragmentation are complete and the live data still sits close to 2 GiB, the default quota may simply be too small for the workload.

4 GiB is:

```text
4294967296
```

8 GiB is:

```text
8589934592
```

For example:

```bash
--quota-backend-bytes=8589934592
```

or:

```bash
ETCD_QUOTA_BACKEND_BYTES=8589934592
```

For a StatefulSet:

```yaml
env:
  - name: ETCD_QUOTA_BACKEND_BYTES
    value: "8589934592"
```

Changing this server setting requires the affected member to restart with the new configuration.

For a three-member cluster, do not restart all three members together. Change and verify one member before moving to the next.

## Why I do not start by changing 2 GiB to 8 GiB

There are two broad cases.

The first is:

```text
old revisions and fragmentation
```

That calls for:

```text
compaction
+
defragmentation
```

The second is:

```text
live data is genuinely approaching the quota
```

That calls for reviewing:

```text
quota
disk capacity
compaction policy
write patterns
```

Without separating those two cases, changing:

```text
2 GiB -> 8 GiB
```

can simply delay the same incident.

## Two useful metrics

If Prometheus is already available, watch:

```text
etcd_mvcc_db_total_size_in_bytes
```

This represents total backend size, including space that may be reclaimable by defragmentation.

Also watch:

```text
etcd_mvcc_db_total_size_in_use_in_bytes
```

This is closer to the space actively in use.

If:

```text
total size is large
size in use is much smaller
```

there is likely significant reclaimable fragmentation.

If:

```text
total size
≈
size in use
≈
quota
```

the live dataset itself is approaching the quota, so defragmentation alone will not solve much.

## Check the automatic compaction policy

After recovering from `NOSPACE`, I also check whether the cluster has a sensible automatic compaction policy:

```text
--auto-compaction-mode
--auto-compaction-retention
```

For example:

```bash
--auto-compaction-mode=periodic
--auto-compaction-retention=10h
```

The right value depends on the workload. Watchers and applications that depend on historical revisions may need a different retention window.

## Summary

I do not treat:

```text
alarm:NOSPACE
```

as an automatic reason to jump straight to:

```text
quota = 8 GiB
```

The sequence is:

```text
NOSPACE
   ↓
alarm list
   ↓
endpoint status / DB SIZE
   ↓
check node filesystem
   ↓
snapshot
   ↓
compact old revisions
   ↓
defragment members
   ↓
check backend size again
   ↓
alarm disarm
   ↓
verify writes
```

If the live backend still approaches 2 GiB after maintenance, then increasing `--quota-backend-bytes` is justified.

That distinction makes it clear whether the cluster actually needs more capacity or simply needs maintenance.

## References

- etcd v3.5 System limits — Storage size limit  
  https://etcd.io/docs/v3.5/dev-guide/limit/
- etcd v3.5 Maintenance — Space quota, compaction and defragmentation  
  https://etcd.io/docs/v3.5/op-guide/maintenance/
- etcd v3.5 Configuration options  
  https://etcd.io/docs/v3.5/op-guide/configuration/
