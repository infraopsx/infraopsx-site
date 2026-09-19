---
layout: ../../../layouts/ArticleLayout.astro
title: "Recovering CephFS from HEALTH_ERR: Filesystem Offline and MDS Rank Damaged"
description: "A practical CephFS incident walkthrough: why standby MDS daemons may not take over a damaged rank, how to read fs dump and health detail, what ceph mds repaired actually does, and how to validate recovery safely."
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

This incident started with a familiar CephFS health state:

```text
HEALTH_ERR
1 filesystem is degraded
1 filesystem is offline
1 mds daemon damaged
```

The OSD layer looked healthy:

```text
3 osds: 3 up, 3 in
177 active+clean
```

and two MDS daemons were available as standbys.

That raises an obvious question:

> If standby MDS daemons exist, why did neither one automatically take over?

The important detail was not the number of standbys. It was that:

```text
CephFS rank 0 had been marked damaged
```

A damaged rank is different from an ordinary failed MDS daemon. A standby cannot simply take over while the rank remains marked damaged.

> Cluster IDs, filesystem names, MDS names, IP addresses, and pool names in this article are generic examples. The original incident ran Ceph Pacific 16.2.5.

## Initial state

```bash
ceph status
```

looked similar to:

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

There are two different layers here.

RADOS:

```text
OSDs are up/in
PGs are active+clean
```

CephFS:

```text
no active MDS rank
filesystem offline
rank damaged
```

So:

> **All PGs being active+clean does not mean CephFS itself is healthy.**

CephFS still depends on MDS state and the logical consistency of its metadata.

## `ceph health detail` shows the dependency chain

```bash
ceph health detail
```

may show:

```text
HEALTH_ERR 1 filesystem is degraded; 1 filesystem is offline; 1 mds daemon damaged

[WRN] FS_DEGRADED: 1 filesystem is degraded
    fs prod-fs is degraded

[ERR] MDS_ALL_DOWN: 1 filesystem is offline
    fs prod-fs is offline because no MDS is active for it.

[ERR] MDS_DAMAGE: 1 mds daemon damaged
    fs prod-fs mds.0 is damaged
```

These are not three unrelated problems.

They form a chain:

```text
rank 0 damaged
        ↓
no MDS can become active for rank 0
        ↓
filesystem offline
        ↓
filesystem degraded
```

The condition to understand first is `MDS_DAMAGE`.

## Why two standbys do not automatically recover the filesystem

```bash
ceph mds stat
```

may show:

```text
prod-fs:0/1 2 up:standby, 1 damaged
```

The two standby daemons are alive.

But the rank is damaged.

MDS daemons and MDS ranks are related but not identical concepts:

```text
MDS daemon
= a running process capable of serving a filesystem rank

MDS rank
= a role in the filesystem that must be owned by a daemon
```

In this incident:

```text
rank 0 = damaged
mds-a  = standby
mds-b  = standby
```

A standby can replace an ordinary failed active daemon, but a rank that is explicitly marked damaged is not treated as a normal failover target.

## An easy-to-misread line in `ceph fs dump`

A shortened:

```bash
ceph fs dump
```

looked like:

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

This line:

```text
damaged 0
```

does **not** mean:

```text
damaged = false
```

It means rank `0` is in the damaged set.

At the same time:

```text
up {}
```

means no rank is currently active.

The filesystem requires rank 0, rank 0 is damaged, and both daemons therefore remain standbys.

## Confirm with `ceph fs status`

```bash
ceph fs status
```

may show:

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

Again, there is no active rank even though standbys exist.

Clients that still have the filesystem mounted may have metadata operations paused or failing.

## Do not treat `ceph mds repaired` as a metadata repair command

The command name is misleading:

```bash
ceph mds repaired <role>
```

It does not repair metadata.

It clears the damaged flag for a filesystem rank so that an MDS daemon may attempt to take that rank again.

If the underlying corruption still exists:

```text
clear damaged flag
        ↓
standby takes the rank
        ↓
MDS reads the same broken metadata
        ↓
rank may become damaged again
```

So:

```bash
ceph mds repaired 0
```

is not a general-purpose CephFS repair command.

## What I collect before clearing the damaged flag

### Save the current state

```bash
ceph status
ceph health detail
ceph mds stat
ceph fs status
ceph fs dump
```

For example:

```bash
ceph status > ceph-status.txt
ceph health detail > ceph-health-detail.txt
ceph fs dump > ceph-fs-dump.txt
```

This is useful if deeper metadata recovery is needed later.

### Verify the RADOS layer

```bash
ceph osd stat
ceph pg stat
ceph health detail
```

Look for:

```text
inactive PGs
incomplete PGs
lost objects
metadata-pool PG problems
```

If the metadata pool itself has unrecoverable object loss, this is not simply an MDS state issue.

### Read the MDS logs

The logs usually contain the real reason the rank became damaged.

Typical areas include:

```text
journal replay failure
missing metadata object
decode errors
assertions
I/O errors
damage-table entries
```

The important point is to find what happened immediately before the rank was first marked damaged.

### Inspect the damage table when possible

When an MDS rank is available for admin commands:

```bash
ceph tell mds.<fs-name>:0 damage ls
```

may show damage types such as:

```text
DENTRY
DIR_FRAG
BACKTRACE
```

Some localized damage can be repaired with CephFS scrub.

Journal or MDS-table corruption is a deeper disaster-recovery case.

## The safer damaged-rank workflow

The logical sequence is:

```text
identify why the rank is damaged
        ↓
repair the underlying problem
        ↓
clear the damaged flag
        ↓
allow a standby to take the rank
```

For damage types that a running MDS scrub can repair, a command may look like:

```bash
ceph tell mds.prod-fs:0 scrub start / recursive,repair
```

Some cases may require `force`, but scrub repair is not universal.

Journal corruption, MDS-table corruption, or serious metadata loss belongs in the CephFS disaster-recovery workflow rather than a trial-and-error sequence of MDS commands.

## What happened in this incident

The original recovery sequence included:

```bash
ceph mds fail prod-fs-b
ceph mds fail prod-fs-a
ceph mds repaired 0
```

After that:

```bash
ceph fs status
```

returned to:

```text
prod-fs - 20 clients
====
RANK      STATE            MDS
 0        active           prod-fs-a
0-s       standby-replay   prod-fs-b
```

and:

```bash
ceph health
```

eventually returned:

```text
HEALTH_OK
```

The result tells us that once the damaged flag was cleared, a standby successfully loaded rank 0 and brought the filesystem back online.

But the commands should not all be interpreted as "the repair".

### `ceph mds fail`

```bash
ceph mds fail <name-or-role>
```

marks an MDS daemon failed.

If the daemon is active and an appropriate standby exists, this triggers failover.

It does not repair metadata.

Failing both standby daemons happened in the original incident, but I would not make that part of the standard procedure for `MDS_DAMAGE`.

### `ceph mds repaired`

The original environment accepted:

```bash
ceph mds repaired 0
```

For documentation I prefer the explicit role:

```bash
ceph mds repaired prod-fs:0
```

That is clearer when multiple CephFS filesystems exist.

This command changes the damaged-rank state. It still does not repair metadata by itself.

## When I would consider clearing the damaged flag

I would first want:

```text
no obvious RADOS data-loss condition
+
no unresolved metadata-pool PG failure
+
MDS logs have been reviewed
+
no clear evidence that journal/metadata corruption still exists
+
a recovery or backup plan exists
```

Then:

```bash
ceph mds repaired prod-fs:0
```

and immediately monitor:

```bash
watch -n 1 ceph fs status
```

in another terminal:

```bash
watch -n 1 ceph health detail
```

A successful takeover may move through replay, reconnect, and rejoin before reaching:

```text
rank 0 active
```

## Validate more than `HEALTH_OK`

### Check CephFS

```bash
ceph fs status
```

Confirm:

```text
rank 0 active
standby coverage restored
clients reconnect
```

### Check the MDS map

```bash
ceph mds stat
```

Make sure there are no remaining:

```text
damaged
failed
```

ranks.

### Check cluster health

```bash
ceph health detail
```

The following should be gone:

```text
MDS_DAMAGE
MDS_ALL_DOWN
FS_DEGRADED
```

### Test actual client I/O

From a mounted CephFS client:

```bash
cd /mnt/cephfs
touch .cephfs-recovery-test
echo ok > .cephfs-recovery-test
cat .cephfs-recovery-test
rm -f .cephfs-recovery-test
```

An active MDS is not the only success criterion. Real metadata operations and file I/O should work too.

### Keep watching MDS logs

If the rank quickly returns to:

```text
MDS_DAMAGE
```

then the damaged flag was cleared but the real metadata problem remains.

Do not keep repeating `ceph mds repaired`.

## If the rank becomes damaged again immediately

This is the important boundary.

If:

```text
repaired
        ↓
standby takes the rank
        ↓
rank becomes damaged again
```

the underlying metadata problem is still present.

At that point the investigation moves into:

```text
CephFS scrub and repair
journal recovery
metadata table recovery
cephfs-journal-tool
cephfs-data-scan
```

These tools can be destructive.

I would not use low-level metadata reconstruction commands without a recovery copy and a clear understanding of what failed.

Ceph's own documentation warns that advanced CephFS metadata repair tools can cause additional damage if used incorrectly.

## Why active+clean PGs do not rule this out

`active+clean` primarily describes RADOS placement-group state.

`MDS_DAMAGE` can result from:

```text
logical metadata inconsistencies
journal replay problems
missing or corrupt metadata objects
software defects
inconsistency left by an earlier failure
```

So these two statements can both be true:

```text
RADOS replication currently looks healthy
```

and:

```text
CephFS metadata cannot be loaded safely
```

That is why CephFS troubleshooting needs more than:

```bash
ceph -s
ceph osd tree
ceph pg stat
```

It also needs:

```bash
ceph fs status
ceph mds stat
ceph fs dump
MDS logs
```

## The sequence I use now

For:

```text
FS_DEGRADED
MDS_ALL_DOWN
MDS_DAMAGE
```

my order is:

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
6. verify metadata-pool and PG health
        ↓
7. inspect MDS logs for the first damage event
        ↓
8. decide whether this is localized damage
   or journal / metadata-table corruption
        ↓
9. repair the underlying problem
        ↓
10. ceph mds repaired <fs>:<rank>
        ↓
11. let a standby take the rank
        ↓
12. validate health and client I/O
```

That makes each command easier to reason about than a simple:

```text
MDS failed
→ fail daemons
→ repaired
```

sequence.

## Three things I kept from this incident

First:

> Having standby MDS daemons does not guarantee automatic failover of a damaged rank.

Second:

> The name `ceph mds repaired` is easy to misread. It clears the damaged state; it does not repair metadata.

Third:

> `HEALTH_OK` matters, but I still verify the active rank, standby coverage, client reconnects, real filesystem I/O, and the MDS logs.

Only then do I consider the CephFS incident closed.

## Version note

The original cluster ran:

```text
Ceph 16.2.5 Pacific
```

Pacific received later maintenance releases.

During an outage I would not combine:

```text
MDS recovery
```

with:

```text
a Ceph upgrade
```

in one change.

Restore the filesystem first, verify stability, then plan the version upgrade separately.

## References

- CephFS health messages  
  https://docs.ceph.com/en/pacific/cephfs/health-messages/
- CephFS administration — MDS commands  
  https://docs.ceph.com/en/pacific/cephfs/administration/
- CephFS disaster recovery  
  https://docs.ceph.com/en/pacific/cephfs/disaster-recovery/
- CephFS advanced metadata repair tools  
  https://docs.ceph.com/en/pacific/cephfs/disaster-recovery-experts/
