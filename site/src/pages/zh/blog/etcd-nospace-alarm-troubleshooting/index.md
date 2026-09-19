---
layout: ../../../../layouts/ArticleLayout.astro
title: "etcd NOSPACE 报警怎么处理：Quota、Compact、Defrag 与 Alarm Recovery"
description: "etcd backend 达到空间配额后会触发 NOSPACE。本文记录如何确认告警、判断 DB SIZE 和实际使用量、执行 compact/defrag、清除 alarm，以及什么时候才应该调整 --quota-backend-bytes。"
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

etcd 报 `NOSPACE` 时，第一反应很容易是：

```text
默认只有 2 GiB，那我把 quota 改成 8 GiB 不就行了？
```

参数确实可以改，但只改配额通常不是完整的处理。

`NOSPACE` 更应该被理解成一个信号：etcd 的 backend 已经逼近或超过当前空间配额，需要先判断空间到底被什么占掉，再决定是清历史版本、做 defrag，还是确实需要扩大 quota。

## 先看 NOSPACE 到底是什么

etcd 默认 backend storage quota 是 **2 GiB**。

可以通过：

```text
--quota-backend-bytes
```

调整。官方文档给出的正常环境建议上限是 **8 GiB**；如果配置超过 8 GiB，etcd 会在启动时给出警告。

8 GiB 换成字节就是：

```text
8589934592
```

例如：

```bash
etcd --quota-backend-bytes=8589934592
```

如果使用环境变量，对应的是：

```bash
ETCD_QUOTA_BACKEND_BYTES=8589934592
```

但这里有个容易忽略的点：

> 8 GiB 是官方建议的最大值，不是“出现 NOSPACE 就应该直接设置成 8 GiB”。

如果 backend 的增长来自大量历史 revision 或内部碎片，把 quota 从 2 GiB 改成 8 GiB，只是把下一次报警往后推。

## NOSPACE 出现以后会发生什么

当某个 member 的 backend database 超过 quota 时，etcd 会触发集群级别的 `NOSPACE` alarm。

常见报错类似：

```text
rpc error: code = 8 desc = etcdserver: mvcc: database space exceeded
```

这时集群进入受限的 maintenance mode。

最直接的检查：

```bash
etcdctl alarm list
```

如果确实是空间配额问题，会看到类似：

```text
memberID:xxxxxxxxxxxxxxxx alarm:NOSPACE
```

这里不要急着执行：

```bash
etcdctl alarm disarm
```

alarm 是结果，不是原因。

如果 backend 仍然超 quota，单纯清 alarm 没有解决空间问题。

## 第一步：先看每个 member 的 backend 大小

先看 endpoint：

```bash
etcdctl endpoint status --cluster -w table
```

输出里重点看：

```text
DB SIZE
```

如果集群启用了 TLS，把正常使用的 endpoint、证书参数一起带上即可。

例如可以先统一：

```bash
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://etcd-0.example:2379,https://etcd-1.example:2379,https://etcd-2.example:2379"
```

再执行：

```bash
etcdctl endpoint status --cluster -w table
etcdctl alarm list
```

如果跑在 Kubernetes 里，也可以直接进一个 etcd Pod 排查：

```bash
kubectl -n etcd-system exec -it etcd-0 -- \
  etcdctl endpoint status --cluster -w table
```

具体 namespace、证书路径和 endpoint 以实际环境为准。

## DB SIZE 大，不一定等于有效数据真的有这么多

这是处理 NOSPACE 时最重要的一个区别。

etcd 的 MVCC 会保留 key 的历史 revision。

例如某个 key 被不停修改：

```text
foo = v1
foo = v2
foo = v3
foo = v4
...
```

从业务视角看可能只有一个 `foo`，但历史版本仍然占用 backend。

另外，即使已经删除旧 revision，backend 文件本身也不会立刻变小。

所以经常会出现：

```text
逻辑数据已经减少
但 db 文件仍然很大
```

这就是为什么 compact 和 defrag 是两个动作。

## Compact 做的是什么

compact 清的是历史 revision。

先取得当前 revision。

官方文档里的做法是从 endpoint status 的 JSON 输出里取 revision，例如：

```bash
rev=$(
  etcdctl endpoint status --write-out=json \
  | grep -o '"revision":[0-9]*' \
  | head -1 \
  | cut -d: -f2
)

echo "$rev"
```

确认 revision 合理以后：

```bash
etcdctl compact "$rev"
```

例如：

```text
compacted revision 1516
```

compact 之后，旧 revision 不再可访问。

所以生产环境里不要把这条命令当成“清缓存”随手执行。

如果业务依赖历史 revision、watch replay，应该先确认保留策略。

etcd 本身也支持自动 compaction，例如按时间保留：

```bash
etcd --auto-compaction-mode=periodic \
     --auto-compaction-retention=10h
```

或者按 revision 数量保留：

```bash
etcd --auto-compaction-mode=revision \
     --auto-compaction-retention=1000
```

具体保留多久，没有一个适合所有集群的固定值。

## 为什么 compact 之后磁盘可能还是没下来

因为 compact 只是让旧 revision 占用的页面变成“可以重新利用”。

它不会自动把 backend 文件里这些空闲页面归还给文件系统。

可以简单理解成：

```text
compact
  ↓
旧 revision 被清理
  ↓
backend 内部出现可复用空间
  ↓
文件本身可能仍然很大
```

真正把这些空闲页收回，需要：

```bash
etcdctl defrag
```

## Defrag 才会真正回收 backend 的碎片空间

单个 member：

```bash
etcdctl --endpoints=https://etcd-0.example:2379 defrag
```

然后依次处理其他 member。

也可以：

```bash
etcdctl defrag --cluster
```

不过在线 defrag 会阻塞当前 member 的读写，所以生产环境里我更倾向于：

```text
一次处理一个 member
确认正常
再处理下一个
```

不要在业务高峰期对所有 member 随手跑一遍。

处理前后可以再次看：

```bash
etcdctl endpoint status --cluster -w table
```

比较 DB SIZE 的变化。

## 一个比较完整的 NOSPACE 处理顺序

实际碰到告警，我会按这个顺序走。

### 1. 确认 alarm

```bash
etcdctl alarm list
```

确认确实存在：

```text
NOSPACE
```

### 2. 看 endpoint 状态和 DB SIZE

```bash
etcdctl endpoint status --cluster -w table
```

确认是哪个 member 的 backend 最接近或已经超过 quota。

### 3. 确认磁盘本身不是也快满了

即使 etcd quota 是 2 GiB，Node 磁盘本身也可能同时存在问题。

```bash
df -h
df -i
```

如果是 Kubernetes：

```bash
kubectl describe node <node>
```

顺便确认是否有：

```text
DiskPressure
```

NOSPACE 和 Node 磁盘不足不是同一个问题，但两个问题完全可能同时出现。

### 4. 先做 snapshot

如果条件允许，我会在 compact / defrag 前先留一份快照：

```bash
etcdctl snapshot save before-nospace-maintenance.db
```

再检查：

```bash
etcdutl --write-out=table \
  snapshot status before-nospace-maintenance.db
```

这一步不是为了“解除 alarm”，只是给维护操作留一个回退点。

### 5. Compact 历史 revision

```bash
rev=$(
  etcdctl endpoint status --write-out=json \
  | grep -o '"revision":[0-9]*' \
  | head -1 \
  | cut -d: -f2
)

etcdctl compact "$rev"
```

### 6. 依次 Defrag member

例如：

```bash
etcdctl --endpoints=https://etcd-0.example:2379 defrag
etcdctl --endpoints=https://etcd-1.example:2379 defrag
etcdctl --endpoints=https://etcd-2.example:2379 defrag
```

使用 TLS 的集群继续带上正常的证书参数。

### 7. 再看 backend 大小

```bash
etcdctl endpoint status --cluster -w table
```

确认已经重新落到 quota 以下。

### 8. 最后才清除 NOSPACE alarm

```bash
etcdctl alarm disarm
```

再检查：

```bash
etcdctl alarm list
```

正常情况下不应该再看到 `NOSPACE`。

### 9. 做一次写入验证

最好不要只看 alarm 消失。

用一个不会影响业务的测试 key 验证：

```bash
etcdctl put /maintenance/nospace-test ok
etcdctl get /maintenance/nospace-test
etcdctl del /maintenance/nospace-test
```

到这里才算恢复完成。

## 那什么时候应该把 quota 从 2 GiB 调大

如果 compact + defrag 以后：

```text
backend 的有效数据本身就已经接近 2 GiB
```

而且确认这些数据确实需要保留，那么 2 GiB 对当前业务已经太小。

这时候增加 quota 才是合理的。

例如调到 4 GiB：

```text
4294967296
```

或者官方建议范围内的 8 GiB：

```text
8589934592
```

命令行：

```bash
--quota-backend-bytes=8589934592
```

环境变量：

```bash
ETCD_QUOTA_BACKEND_BYTES=8589934592
```

如果 etcd 跑在 StatefulSet 里，可以类似这样：

```yaml
env:
  - name: ETCD_QUOTA_BACKEND_BYTES
    value: "8589934592"
```

修改这类 server 配置以后需要让对应 etcd member 以新配置重新启动。

三节点集群里不要同时把三个 member 一把重启。

我一般会：

```text
改一个 member
  ↓
确认重新加入并健康
  ↓
再处理下一个
```

## 为什么我不把“改成 8 GiB”放在第一步

因为 NOSPACE 大体可能有两种情况。

第一种：

```text
大量旧 revision / 碎片
```

这种情况更应该：

```text
compact
+
defrag
```

第二种：

```text
有效数据确实持续增长
```

这种情况才需要重新评估：

```text
quota
磁盘容量
compaction 策略
业务写入模式
```

如果不区分原因：

```text
2 GiB → 8 GiB
```

很可能只是把告警从今天推迟到以后。

## 两个指标值得长期看

如果已经有 Prometheus，可以关注：

```text
etcd_mvcc_db_total_size_in_bytes
```

它表示 backend 的总大小，包括可以通过 defrag 回收的空间。

另一个：

```text
etcd_mvcc_db_total_size_in_use_in_bytes
```

更接近当前实际在使用的数据量。

这两个指标放在一起比较很有用。

如果：

```text
total size 很大
size in use 明显小很多
```

通常说明碎片比较明显，defrag 有回收空间的价值。

如果：

```text
total size
≈
size in use
≈
quota
```

那问题更接近“有效数据真的快把 quota 用完了”，只做 defrag 帮助不会太大。

## 别忘了自动 compaction

如果这是一个长期运行的 etcd 集群，只处理一次 NOSPACE 还不够。

应该顺便看当前有没有自动 compaction：

```text
--auto-compaction-mode
--auto-compaction-retention
```

例如保留 10 小时历史：

```bash
--auto-compaction-mode=periodic
--auto-compaction-retention=10h
```

具体值还是看业务。

watch、历史 revision 使用方式不同，不能看到网上一个参数就全部照抄。

## 最后整理一下

我现在处理 etcd NOSPACE，不会直接从：

```text
alarm:NOSPACE
```

跳到：

```text
quota = 8 GiB
```

而是：

```text
NOSPACE
   ↓
alarm list
   ↓
endpoint status / DB SIZE
   ↓
确认 Node 磁盘状态
   ↓
snapshot
   ↓
compact 历史 revision
   ↓
逐 member defrag
   ↓
重新确认 backend size
   ↓
alarm disarm
   ↓
写入验证
```

如果清理以后 backend 的有效数据仍然逼近 2 GiB，再去调整 `--quota-backend-bytes`。

这样处理，至少能知道这 2 GiB 到底是“真数据”，还是历史 revision 和碎片堆出来的。

## References

- etcd v3.5 System limits — Storage size limit  
  https://etcd.io/docs/v3.5/dev-guide/limit/
- etcd v3.5 Maintenance — Space quota, compaction and defragmentation  
  https://etcd.io/docs/v3.5/op-guide/maintenance/
- etcd v3.5 Configuration options  
  https://etcd.io/docs/v3.5/op-guide/configuration/
