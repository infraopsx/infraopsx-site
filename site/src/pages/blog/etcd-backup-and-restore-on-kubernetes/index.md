---
layout: ../../../layouts/ArticleLayout.astro
title: "Backing Up and Restoring etcd on Kubernetes: A Three-Member Recovery Test"
description: "A practical etcd backup and restore test on Kubernetes: snapshots every four hours, seven-day retention, and a full three-member recovery validated with member, endpoint, and revision checks."
pubDate: "2026-09-19"
category: Databases
tags:
  - etcd
  - Kubernetes
  - Backup
  - Disaster Recovery
  - StatefulSet
enPath: "/blog/etcd-backup-and-restore-on-kubernetes/"
zhPath: "/zh/blog/etcd-backup-and-restore-on-kubernetes/"
---

This is a record of an etcd backup and recovery test I actually ran.

The cluster had three members. The goal was straightforward:

- take one snapshot when the Pod starts;
- take another snapshot every four hours;
- keep seven days of snapshots;
- restore one of those snapshots into a separate namespace;
- rebuild all three members and verify the recovered cluster.

The last step mattered most. A directory full of `.db` files is not proof that the backup can actually be restored.

> Environment-specific details such as namespaces, StorageClasses, PVC IDs, member IDs and ClusterIPs have been replaced with generic values. The original test used etcd 3.5.0, so the examples keep that version. A production deployment should also add TLS, authentication and stricter security controls.

## Cluster layout

The cluster runs as a three-replica StatefulSet:

```text
etcd-0
etcd-1
etcd-2
```

Each Pod has two persistent volumes:

```text
data    -> etcd data
backup  -> snapshot files
```

A `backup` sidecar in each Pod takes snapshots from the local member.

For the public example I use a Headless Service so the StatefulSet members have stable DNS names:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: etcd-headless
  namespace: etcd-lab
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector:
    app: etcd
  ports:
    - name: client
      port: 2379
    - name: peer
      port: 2380
    - name: metrics
      port: 2381
```

The relevant part of the StatefulSet looks like this:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: etcd
  namespace: etcd-lab
spec:
  serviceName: etcd-headless
  replicas: 3
  podManagementPolicy: Parallel

  selector:
    matchLabels:
      app: etcd

  template:
    metadata:
      labels:
        app: etcd
    spec:
      containers:
        - name: backup
          image: quay.io/coreos/etcd:v3.5.0
          command:
            - /bin/sh
            - -c
            - |
              while true; do
                find /backup -type f -name '*.db' -mtime +7 -delete

                backup_name="${NODE_NAME}-etcd-snapshot-$(date +%Y%m%d_%H%M%S).db"

                etcdctl \
                  --endpoints=http://127.0.0.1:2379 \
                  snapshot save "/backup/${backup_name}"

                etcdutl \
                  --write-out=table \
                  snapshot status "/backup/${backup_name}"

                sleep 4h
              done
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
            - name: backup
              mountPath: /backup

        - name: etcd
          image: quay.io/coreos/etcd:v3.5.0
          command:
            - /bin/sh
            - -c
            - |
              exec etcd \
                --name "${NODE_NAME}" \
                --data-dir /data/data.etcd \
                --listen-client-urls http://0.0.0.0:2379 \
                --advertise-client-urls "http://${NODE_NAME}.etcd-headless.etcd-lab.svc:2379" \
                --listen-peer-urls http://0.0.0.0:2380 \
                --initial-advertise-peer-urls "http://${NODE_NAME}.etcd-headless.etcd-lab.svc:2380" \
                --listen-metrics-urls http://0.0.0.0:2381 \
                --initial-cluster "${ETCD_CLUSTER}" \
                --initial-cluster-token etcd-cluster \
                --initial-cluster-state new
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: ETCD_CLUSTER
              value: >-
                etcd-0=http://etcd-0.etcd-headless.etcd-lab.svc:2380,
                etcd-1=http://etcd-1.etcd-headless.etcd-lab.svc:2380,
                etcd-2=http://etcd-2.etcd-headless.etcd-lab.svc:2380
          volumeMounts:
            - name: data
              mountPath: /data/data.etcd

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: fast-block
        resources:
          requests:
            storage: 32Gi

    - metadata:
        name: backup
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: fast-block
        resources:
          requests:
            storage: 32Gi
```

`fast-block` is only a placeholder. It needs to be replaced with a StorageClass that exists in the target cluster.

With this layout, every member keeps its own snapshots. That uses more storage, but it also avoids relying on a single backup volume. If only one cluster-level copy is needed, the same backup job can be moved into a CronJob instead.

## Check that backups are actually being created

I first check one member's backup directory:

```bash
kubectl -n etcd-lab exec -it etcd-0 -c backup -- ls -lh /backup
```

For example:

```text
-rw------- 1 root root 152K Sep 19 00:00 etcd-0-etcd-snapshot-20260919_000000.db
-rw------- 1 root root 152K Sep 19 04:00 etcd-0-etcd-snapshot-20260919_040000.db
-rw------- 1 root root 152K Sep 19 08:00 etcd-0-etcd-snapshot-20260919_080000.db
```

Then inspect the newest snapshot:

```bash
kubectl -n etcd-lab exec -it etcd-0 -c backup -- \
  etcdutl --write-out=table snapshot status \
  /backup/etcd-0-etcd-snapshot-20260919_080000.db
```

The test snapshot looked roughly like this:

```text
+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| ******** |      274 |        112 |     152 kB |
+----------+----------+------------+------------+
```

I kept two values in mind:

```text
revision = 274
snapshot size ≈ 152 kB
```

They are useful later when checking the restored cluster.

## Restore into a separate namespace

I did not restore directly over the running cluster.

Instead I created a separate namespace:

```text
etcd-recovery
```

The idea was simple:

```text
running cluster
      │
      ├── copy one snapshot
      │
      └── rebuild three members in etcd-recovery
```

If the test fails, the recovery namespace can be removed without touching the original cluster.

Copy a snapshot out first:

```bash
kubectl -n etcd-lab cp \
  -c backup \
  etcd-0:/backup/etcd-0-etcd-snapshot-20260919_080000.db \
  backup.db
```

Then prepare three PVCs:

```text
data-etcd-0
data-etcd-1
data-etcd-2
```

Each PVC will become the data volume of one recovered member.

## Use one temporary Pod to populate all three PVCs

The restore Pod mounts all three PVCs:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: etcd-recovery
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-etcd-0
  namespace: etcd-recovery
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-block
  resources:
    requests:
      storage: 32Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-etcd-1
  namespace: etcd-recovery
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-block
  resources:
    requests:
      storage: 32Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-etcd-2
  namespace: etcd-recovery
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-block
  resources:
    requests:
      storage: 32Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: restore-pod
  namespace: etcd-recovery
spec:
  hostAliases:
    - ip: "127.0.0.1"
      hostnames:
        - "etcd-0.etcd-headless"
        - "etcd-1.etcd-headless"
        - "etcd-2.etcd-headless"

  containers:
    - name: restore
      image: quay.io/coreos/etcd:v3.5.0
      command: ["sh", "-c", "sleep infinity"]
      volumeMounts:
        - name: etcd-0
          mountPath: /var/lib/etcd0
        - name: etcd-1
          mountPath: /var/lib/etcd1
        - name: etcd-2
          mountPath: /var/lib/etcd2

  volumes:
    - name: etcd-0
      persistentVolumeClaim:
        claimName: data-etcd-0
    - name: etcd-1
      persistentVolumeClaim:
        claimName: data-etcd-1
    - name: etcd-2
      persistentVolumeClaim:
        claimName: data-etcd-2
```

Create it:

```bash
kubectl apply -f restore.yaml
```

Once the Pod is running, copy the snapshot in:

```bash
kubectl -n etcd-recovery cp \
  backup.db \
  restore-pod:/tmp/etcd-snapshot.db
```

I check the snapshot one more time before writing any of the PVCs:

```bash
kubectl -n etcd-recovery exec -it restore-pod -- \
  etcdutl --write-out=table snapshot status /tmp/etcd-snapshot.db
```

For a restore operation, this extra check is worth the few seconds it takes.

## Restore all three members from the same snapshot

Open a shell in the restore Pod:

```bash
kubectl -n etcd-recovery exec -it restore-pod -- sh
```

Define the new cluster:

```bash
CLUSTER="etcd-0=http://etcd-0.etcd-headless:2380,etcd-1=http://etcd-1.etcd-headless:2380,etcd-2=http://etcd-2.etcd-headless:2380"
```

Restore `etcd-0`:

```bash
etcdutl snapshot restore /tmp/etcd-snapshot.db \
  --name etcd-0 \
  --data-dir /var/lib/etcd0 \
  --initial-cluster "${CLUSTER}" \
  --initial-advertise-peer-urls http://etcd-0.etcd-headless:2380
```

Restore `etcd-1`:

```bash
etcdutl snapshot restore /tmp/etcd-snapshot.db \
  --name etcd-1 \
  --data-dir /var/lib/etcd1 \
  --initial-cluster "${CLUSTER}" \
  --initial-advertise-peer-urls http://etcd-1.etcd-headless:2380
```

Restore `etcd-2`:

```bash
etcdutl snapshot restore /tmp/etcd-snapshot.db \
  --name etcd-2 \
  --data-dir /var/lib/etcd2 \
  --initial-cluster "${CLUSTER}" \
  --initial-advertise-peer-urls http://etcd-2.etcd-headless:2380
```

After that, each PVC contains a normal etcd data directory:

```text
member/
├── snap/
└── wal/
```

One detail is easy to miss: restoring a snapshot creates a new logical cluster, so new cluster and member IDs are expected. Those IDs should not be compared with the original cluster.

The useful checks are:

```text
Is the data present?
Is the revision correct?
Can the three members form a healthy cluster?
```

## Start the recovered cluster

Delete the temporary restore Pod first so the PVCs can be mounted by the StatefulSet:

```bash
kubectl -n etcd-recovery delete pod restore-pod
```

Then create the Headless Service and three-replica StatefulSet in `etcd-recovery`.

The StatefulSet should reuse:

```text
data-etcd-0
data-etcd-1
data-etcd-2
```

After startup:

```bash
kubectl -n etcd-recovery get pods
```

Expected:

```text
NAME     READY   STATUS    RESTARTS
etcd-0   1/1     Running   0
etcd-1   1/1     Running   0
etcd-2   1/1     Running   0
```

## Validate the restored cluster

Check membership:

```bash
kubectl -n etcd-recovery exec -it etcd-0 -- \
  etcdctl member list -w table
```

All three members should be started.

Then check endpoints:

```bash
kubectl -n etcd-recovery exec -it etcd-0 -- \
  etcdctl endpoint status --cluster -w table
```

The main things I look for are:

```text
all three endpoints respond
exactly one member is leader
no endpoint reports an error
```

Finally, check the revision:

```bash
kubectl -n etcd-recovery exec -it etcd-0 -- \
  etcdctl get --count-only --prefix / -w fields
```

In this test:

```text
Revision : 274
Count    : 42
```

The recovered revision matched the snapshot.

At that point I considered the backup actually tested.

## A few notes from the exercise

### `snapshot save` and `snapshot restore` now use different tools

The original operation notes used:

```bash
etcdctl snapshot status
etcdctl snapshot restore
```

and already printed deprecation warnings.

The published version uses:

```bash
etcdctl snapshot save ...
etcdutl snapshot status ...
etcdutl snapshot restore ...
```

### A scheduled snapshot is not the same as tested recovery

It is easy to focus on whether:

```text
snapshots are created on schedule
old files are deleted
```

The more useful question is whether a snapshot can rebuild a working cluster.

That means periodically checking the entire path:

```text
snapshot
  ↓
restore
  ↓
three members start
  ↓
leader election succeeds
  ↓
revision and data look correct
```

### The HTTP examples are intentionally simple

The examples use plain `http://` so the backup and restore flow stays readable.

That is not a production security recommendation. A real etcd deployment should use the appropriate client/peer TLS and authentication configuration.

### Namespaces, StorageClass names and sizes are examples

Values such as:

```text
etcd-lab
etcd-recovery
fast-block
32Gi
```

are placeholders and should be adapted to the target cluster.

## References

- etcd v3.5 maintenance / snapshot backup  
  https://etcd.io/docs/v3.5/op-guide/maintenance/
- etcd v3.5 operations guide  
  https://etcd.io/docs/v3.5/op-guide/
- Kubernetes StatefulSet  
  https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
