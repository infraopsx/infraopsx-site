---
layout: ../../../../layouts/ArticleLayout.astro
title: "在 Kubernetes 中备份和恢复 etcd：从定时快照到三节点恢复验证"
description: "记录一次三节点 etcd 的完整备份与恢复验证：每 4 小时生成快照、保留 7 天，并在独立命名空间中恢复三成员集群，最后校验 member、endpoint 和 revision。"
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

这篇主要记录一次实际做过的 etcd 备份和恢复验证。

当时跑的是一个 3 成员 etcd 集群，目标很简单：

- Pod 启动后先做一次快照；
- 之后每 4 小时备份一次；
- 快照保留 7 天；
- 真正拿其中一份快照，在另一个 namespace 里把 3 成员集群恢复出来；
- 最后确认 member、endpoint 和 revision 都正常。

我比较在意最后一点。备份文件存在，并不等于这份备份真的能恢复。

> 公开版里把 namespace、StorageClass、PVC、member ID、ClusterIP 等环境信息都换成了通用名称。原测试环境使用 etcd 3.5.0，文中的版本也保留这一点。生产环境还需要补 TLS、认证和更严格的权限控制。

## 集群结构

集群由 StatefulSet 管理，3 个副本：

```text
etcd-0
etcd-1
etcd-2
```

每个 Pod 有两块独立存储：

```text
data    -> etcd 数据目录
backup  -> 快照目录
```

每个 Pod 里还有一个 `backup` sidecar，负责给当前 member 做快照。

公开示例里 Service 使用 Headless Service，让 StatefulSet 的 Pod 有稳定的 DNS：

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

StatefulSet 的核心配置如下，省略了一些和本文无关的字段：

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

`fast-block` 只是示例名称，实际使用时换成集群自己的 StorageClass。

这个方案有一个很直观的特点：3 个 member 都会各自留下快照。磁盘会多占一些，但某个 member 的备份卷出问题时，不至于只剩唯一一份副本。如果只准备保留一份集群快照，也可以把备份逻辑单独做成 CronJob。

## 先确认备份是不是真的在生成

我会先看一个 member 的 `/backup`：

```bash
kubectl -n etcd-lab exec -it etcd-0 -c backup -- ls -lh /backup
```

类似：

```text
-rw------- 1 root root 152K Sep 19 00:00 etcd-0-etcd-snapshot-20260919_000000.db
-rw------- 1 root root 152K Sep 19 04:00 etcd-0-etcd-snapshot-20260919_040000.db
-rw------- 1 root root 152K Sep 19 08:00 etcd-0-etcd-snapshot-20260919_080000.db
```

然后检查最新快照：

```bash
kubectl -n etcd-lab exec -it etcd-0 -c backup -- \
  etcdutl --write-out=table snapshot status \
  /backup/etcd-0-etcd-snapshot-20260919_080000.db
```

测试时的快照大致是：

```text
+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| ******** |      274 |        112 |     152 kB |
+----------+----------+------------+------------+
```

这里我主要记住两个东西：

```text
revision = 274
snapshot size ≈ 152 kB
```

后面恢复完成后还要回来对。

## 为什么不直接在原集群上恢复

恢复测试我没有直接碰原来的 3 个 member，而是新建了一个 namespace：

```text
etcd-recovery
```

这样做比较省心：

```text
原集群继续运行
        │
        ├── 取出一份 snapshot
        │
        └── 在 etcd-recovery 中重新构建 3 个 member
```

恢复失败，可以直接删测试 namespace；恢复成功，再验证数据。

先把快照拿出来：

```bash
kubectl -n etcd-lab cp \
  -c backup \
  etcd-0:/backup/etcd-0-etcd-snapshot-20260919_080000.db \
  backup.db
```

本地确认：

```bash
ls -lh backup.db
```

然后准备 3 个 PVC：

```text
data-etcd-0
data-etcd-1
data-etcd-2
```

每块 PVC 对应恢复后的一个 member。

## 用一个临时 Pod 写入三个 PVC

恢复时我用了一个临时 Pod，同时挂载 3 个 PVC。

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

创建：

```bash
kubectl apply -f restore.yaml
```

等 Pod Running 后，把快照复制进去：

```bash
kubectl -n etcd-recovery cp \
  backup.db \
  restore-pod:/tmp/etcd-snapshot.db
```

再检查一次：

```bash
kubectl -n etcd-recovery exec -it restore-pod -- \
  etcdutl --write-out=table snapshot status /tmp/etcd-snapshot.db
```

我不太喜欢在“恢复”这种操作里省掉这一步。复制过程中即使出了问题，也最好在真正写 PVC 之前发现。

## 从同一份 snapshot 恢复三个 member

进入恢复 Pod：

```bash
kubectl -n etcd-recovery exec -it restore-pod -- sh
```

先定义新集群：

```bash
CLUSTER="etcd-0=http://etcd-0.etcd-headless:2380,etcd-1=http://etcd-1.etcd-headless:2380,etcd-2=http://etcd-2.etcd-headless:2380"
```

恢复 `etcd-0`：

```bash
etcdutl snapshot restore /tmp/etcd-snapshot.db \
  --name etcd-0 \
  --data-dir /var/lib/etcd0 \
  --initial-cluster "${CLUSTER}" \
  --initial-advertise-peer-urls http://etcd-0.etcd-headless:2380
```

恢复 `etcd-1`：

```bash
etcdutl snapshot restore /tmp/etcd-snapshot.db \
  --name etcd-1 \
  --data-dir /var/lib/etcd1 \
  --initial-cluster "${CLUSTER}" \
  --initial-advertise-peer-urls http://etcd-1.etcd-headless:2380
```

恢复 `etcd-2`：

```bash
etcdutl snapshot restore /tmp/etcd-snapshot.db \
  --name etcd-2 \
  --data-dir /var/lib/etcd2 \
  --initial-cluster "${CLUSTER}" \
  --initial-advertise-peer-urls http://etcd-2.etcd-headless:2380
```

恢复完成后，3 个 PVC 的根目录下都会有：

```text
member/
├── snap/
└── wal/
```

这里有个容易误会的地方：恢复后会重新生成 cluster ID 和 member ID，所以不要拿新 member ID 去和旧集群逐个比较。

真正需要确认的是：

```text
数据是否回来
revision 是否符合预期
三个 member 能否正常组成集群
```

## 启动恢复后的集群

先删掉临时恢复 Pod，让 PVC 可以重新挂载：

```bash
kubectl -n etcd-recovery delete pod restore-pod
```

然后在 `etcd-recovery` 里创建 Headless Service 和 3 副本 StatefulSet。

StatefulSet 使用：

```text
data-etcd-0
data-etcd-1
data-etcd-2
```

这三个已经写入恢复数据的 PVC。

启动后：

```bash
kubectl -n etcd-recovery get pods
```

预期：

```text
NAME     READY   STATUS    RESTARTS
etcd-0   1/1     Running   0
etcd-1   1/1     Running   0
etcd-2   1/1     Running   0
```

## 最后才是关键：验证恢复结果

先看 member：

```bash
kubectl -n etcd-recovery exec -it etcd-0 -- \
  etcdctl member list -w table
```

应该能看到 3 个 started member。

再看 endpoint：

```bash
kubectl -n etcd-recovery exec -it etcd-0 -- \
  etcdctl endpoint status --cluster -w table
```

我关注的主要是：

```text
3 个 endpoint 都能返回
有且只有 1 个 leader
没有 endpoint error
```

最后检查 revision：

```bash
kubectl -n etcd-recovery exec -it etcd-0 -- \
  etcdctl get --count-only --prefix / -w fields
```

恢复测试里：

```text
Revision : 274
Count    : 42
```

revision 和备份文件里的 `274` 对上了。

到这里，这份 snapshot 才算真正经过恢复验证。

## 几个后来觉得值得记下的点

### 1. `snapshot save` 和 `snapshot restore` 不是一个工具了

原来的操作记录使用：

```bash
etcdctl snapshot status
etcdctl snapshot restore
```

执行时已经会看到：

```text
Deprecated: Use `etcdutl ...` instead.
```

所以公开版改成：

```bash
etcdctl snapshot save ...
etcdutl snapshot status ...
etcdutl snapshot restore ...
```

这样更清楚。

### 2. 定时备份不代表灾备完成

我以前更容易关注：

```text
快照有没有按时生成
保留策略有没有生效
```

但真正做完一次恢复后，会发现更重要的是：

```text
这份快照能不能重新组成集群
数据 revision 对不对
恢复流程有没有遗漏
```

备份最好定期做恢复演练，而不是只看 `/backup` 目录里有没有 `.db`。

### 3. 示例里的 HTTP 只适合说明流程

本文为了把备份和恢复流程讲清楚，示例用了：

```text
http://
```

生产环境不要直接照搬。etcd 的 client 和 peer 通信应该根据实际环境配置 TLS、证书和认证。

### 4. StorageClass、namespace 和容量都不是固定值

文章里的：

```text
etcd-lab
etcd-recovery
fast-block
32Gi
```

只是为了让示例完整。

这些值都应该按实际集群调整。

## 小结

这次做完后，我给 etcd 备份的判断标准变得很简单：

```text
有 snapshot
    ↓
snapshot status 正常
    ↓
能从一份 snapshot 恢复出 3 个 member
    ↓
新集群能选出 leader
    ↓
revision 和数据检查通过
```

走到最后一步，才算真正验证过备份。

## References

- etcd v3.5 maintenance / snapshot backup  
  https://etcd.io/docs/v3.5/op-guide/maintenance/
- etcd v3.5 operations guide  
  https://etcd.io/docs/v3.5/op-guide/
- Kubernetes StatefulSet  
  https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
