---
layout: ../../../../layouts/ArticleLayout.astro
title: "CephFS HEALTH_WARN：MDS_CLIENT_LATE_RELEASE 与 MDS_SLOW_REQUEST 排查"
description: "一次 CephFS HEALTH_WARN 的真实排障记录：通过 health detail 定位无法及时释放 capability 的客户端，确认客户端状态后手工 evict，并解释为什么 client evict 不应该作为第一步。"
pubDate: "2026-09-19"
category: Storage
tags:
  - Ceph
  - CephFS
  - MDS
  - Kubernetes
  - CSI
  - Troubleshooting
enPath: "/blog/cephfs-client-late-release-mds-slow-request/"
zhPath: "/zh/blog/cephfs-client-late-release-mds-slow-request/"
---

这次故障不复杂，但很典型。

日常巡检时看到 Ceph 集群从 `HEALTH_OK` 变成了 `HEALTH_WARN`：

```text
cluster:
  health: HEALTH_WARN
          1 clients failing to respond to capability release
          1 MDSs report slow requests
```

PG 全部是 `active+clean`，OSD 也是 `up/in`，CephFS volume 仍然显示 healthy。

真正异常的是 MDS 和一个 CephFS client。

最后通过：

```bash
ceph health detail
```

定位到了具体 client，在确认它已经异常、可以被驱逐后执行：

```bash
ceph tell mds.<mds-name> client evict id=<client-id>
```

集群恢复：

```text
health: HEALTH_OK
```

但重新整理这次记录以后，我觉得最值得记住的不是 `client evict` 这一条命令，而是：

> `MDS_CLIENT_LATE_RELEASE` 和 `MDS_SLOW_REQUEST` 只是症状。先判断客户端为什么不响应，再决定是否驱逐。

因为 CephFS client eviction 不是无害操作。如果客户端还有 buffered I/O，没有刷到后端的数据可能丢失。

> 文中的 cluster ID、主机名、IP、文件系统名、MDS daemon 名和 client ID 均已替换为通用示例。

# 1. 从 `ceph status` 发现异常

当时首先看到：

```bash
ceph status
```

类似：

```text
cluster:
  health: HEALTH_WARN
          1 clients failing to respond to capability release
          1 MDSs report slow requests

services:
  mon: 3 daemons, quorum ...
  mgr: active, standbys: ...
  mds: 1/1 daemons up, 2 standby
  osd: 3 osds: 3 up, 3 in

data:
  volumes: 1/1 healthy
  pgs:     241 active+clean
```

这个输出很有意思：

```text
OSD up/in
PG active+clean
CephFS volume healthy
```

但 cluster health 仍然是：

```text
HEALTH_WARN
```

所以这次不是典型的 OSD down、PG degraded 或 metadata pool 不健康。

警告已经直接指向：

```text
CephFS client
MDS request
```

# 2. 用 `ceph health detail` 找到具体 client

继续执行：

```bash
ceph health detail
```

得到类似：

```text
HEALTH_WARN
1 clients failing to respond to capability release;
1 MDSs report slow requests

[WRN] MDS_CLIENT_LATE_RELEASE:
1 clients failing to respond to capability release

mds.example-fs.mds-node-a(mds.0):
Client worker-node-a:csi-cephfs-node
failing to respond to capability release
client_id: 123456

[WRN] MDS_SLOW_REQUEST:
1 MDSs report slow requests

mds.example-fs.mds-node-a(mds.0):
3 slow requests are blocked > 30 secs
```

这里已经给出了三个关键值：

```text
MDS daemon
Client name
Client ID
```

例如：

```text
MDS       = mds.example-fs.mds-node-a
Client    = worker-node-a:csi-cephfs-node
Client ID = 123456
```

这时候还不应该直接执行 `client evict`。

# 3. `MDS_CLIENT_LATE_RELEASE` 到底是什么意思

CephFS 的客户端会从 MDS 获得 capability。

可以简单理解成：

```text
MDS
 ↓
把某些 inode / metadata 操作权限交给 client
 ↓
client 持有 capability
```

当 MDS 需要收回 capability 时，会要求 client release。

正常情况：

```text
MDS 请求 release
        ↓
client 响应
        ↓
capability 被回收
```

异常情况：

```text
MDS 请求 release
        ↓
client 长时间没有回应
        ↓
MDS_CLIENT_LATE_RELEASE
```

Ceph 官方对这个 health warning 的说明也是：

> 客户端没有及时响应 capability release 请求。

这不等于：

```text
MDS 自己一定坏了
```

客户端可能：

```text
卡死
负载过高
网络异常
内核 / CephFS client 异常
节点失联
CSI 相关进程异常
```

仅凭 `health detail` 还不能确定是哪一种。

# 4. `MDS_SLOW_REQUEST` 也不是根因结论

同一次 health detail 还出现：

```text
MDS_SLOW_REQUEST
3 slow requests are blocked > 30 secs
```

这个警告表示：

```text
某些 metadata request 长时间没有完成
```

但原因可能有很多，例如：

```text
MDS 本身运行缓慢
RADOS 对 metadata journal 写入响应慢
客户端相关操作被阻塞
软件问题
```

所以看到：

```text
MDS_SLOW_REQUEST
```

不要立即得出：

```text
“MDS 性能不够，重启 MDS”
```

在这次现场里，`MDS_CLIENT_LATE_RELEASE` 和 `MDS_SLOW_REQUEST` 同时出现，而且最终驱逐那个异常 client 后两个 warning 都消失了。

这说明它们在这次事件中高度相关。

但这并不能证明所有 `MDS_SLOW_REQUEST` 都应该靠驱逐 client 解决。

# 5. 驱逐前，先把 client 查清楚

官方文档建议手工 eviction 之前先检查 client list。

可以执行：

```bash
ceph tell mds.<mds-name> client ls
```

例如：

```bash
ceph tell mds.example-fs.mds-node-a client ls
```

输出中会包含类似：

```json
{
  "id": 123456,
  "state": "open",
  "inst": "client.123456 192.0.2.10:0/123456789",
  "client_metadata": {
    "hostname": "worker-node-a"
  }
}
```

重点确认：

```text
id
state
inst
hostname
mount point（如果提供）
client metadata
```

这里的目的不是单纯“找到 ID”。

而是回答：

> 这个 client 到底是谁，它现在是不是还在承担正常业务？

# 6. 如果它来自 Kubernetes / Ceph CSI

我这次 health detail 中 client 名里出现了：

```text
csi-cephfs-node
```

这意味着它和 Kubernetes CephFS CSI 客户端有关。

这时候我会继续对照：

```bash
kubectl get nodes -o wide
```

以及 CephFS CSI nodeplugin：

```bash
kubectl -n rook-ceph get pod -o wide | grep cephfs
```

找到对应节点后看 plugin 日志。

不同 Rook / CSI 版本 Pod 名会有区别，不要死记某一个名字。

重点还是确认：

```text
这个 node 是否在线
CephFS CSI plugin 是否正常
应用 Pod 是否仍在使用 CephFS
节点是否刚发生过重启 / 网络异常
```

如果节点本身正常，而且业务还在持续写这个文件系统，直接 evict 不是一个合理的第一动作。

# 7. 什么情况下才考虑手工 evict

Ceph 官方给出的典型场景是：

```text
client 已经失效
client 行为异常
无法到客户端节点正常 unmount
不希望继续等 session timeout
```

这种情况下才考虑：

```bash
ceph tell mds.<mds-name> client evict id=<client-id>
```

这次现场最终执行的是：

```bash
ceph tell mds.example-fs.mds-node-a \
  client evict id=123456
```

命令执行后，再看：

```bash
ceph status
```

恢复为：

```text
health: HEALTH_OK
```

说明那个 client session 确实与这次 health warning 有直接关系。

# 8. 为什么 `client evict` 要谨慎

这是这篇文章最重要的一点。

CephFS 的 manual eviction 不只是：

```text
“从 MDS client list 删除一条记录”
```

正常配置下，eviction 会阻止这个客户端继续访问 MDS 和 OSD。

也就是说它实际上是在做 client fencing。

如果被驱逐的客户端当时还有：

```text
buffered write
尚未 flush 的数据
```

这些数据可能丢失。

所以我不会写成：

```text
看到 MDS_CLIENT_LATE_RELEASE
        ↓
复制 client_id
        ↓
直接 client evict
```

我现在的流程是：

```text
发现 late release
        ↓
确认 client 身份
        ↓
确认节点状态
        ↓
确认业务是否还在使用
        ↓
能正常 unmount？
        ├─ 能 → 优先正常停止 / unmount
        └─ 不能
             ↓
       确认 client 已异常或必须隔离
             ↓
         client evict
```

# 9. eviction 后，客户端通常应该重新挂载

手工驱逐后，不要默认旧 client 可以继续若无其事地使用原来的 mount。

Ceph 官方的建议是：

```text
unmount
        ↓
fresh mount
```

在 Kubernetes + CSI 场景里，通常应该让：

```text
CSI / kubelet
```

重新完成 mount 流程，而不是手工把一个已被 eviction 的老 client 强行恢复回来。

Ceph 也支持从 blocklist 中移除客户端，但官方明确提醒这样做可能带来数据完整性风险，而且也不能保证旧 client 能恢复到正常状态。

所以：

```bash
ceph osd blocklist rm ...
```

不是 `client evict` 后的固定下一步。

# 10. 为什么这次 `MDS_SLOW_REQUEST` 一起消失

事故现场里：

```text
MDS_CLIENT_LATE_RELEASE
+
MDS_SLOW_REQUEST
```

同时存在。

驱逐异常 client 后：

```text
HEALTH_WARN
        ↓
HEALTH_OK
```

一个合理的判断是：

```text
这个异常 client 很可能参与了当时阻塞的 metadata 操作
```

但从现有记录，我们无法进一步证明：

```text
为什么这个 client 最初没有及时 release capability
```

因为当时没有保存：

```text
对应 node 的系统日志
CSI plugin 日志
网络状态
client 内核日志
MDS outstanding ops
```

所以文章只记录已经能证明的事实：

```text
异常 client 被定位
        ↓
确认后手工 evict
        ↓
两个 MDS health warning 消失
        ↓
cluster HEALTH_OK
```

不会反过来编一个不存在的“根因”。

# 11. 如果下次再遇到，我会多查一步

这次历史记录里基本是：

```text
ceph status
        ↓
ceph health detail
        ↓
client evict
```

如果再遇到一次，我会在 eviction 前至少补：

```bash
ceph tell mds.<mds-name> client ls
```

然后把目标 client 的：

```text
hostname
client address
state
metadata
```

保存下来。

对于 `MDS_SLOW_REQUEST`，还会继续检查 MDS 当前 outstanding ops，而不是只看 health message。

这样下次就可能回答：

```text
到底是某个 client 卡住
还是 MDS / RADOS 本身慢
```

而不是只知道“evict 后好了”。

# 12. 恢复后的验证

至少检查：

```bash
ceph status
```

确认：

```text
HEALTH_OK
```

然后再执行：

```bash
ceph health detail
```

确认原来的：

```text
MDS_CLIENT_LATE_RELEASE
MDS_SLOW_REQUEST
```

已经不再出现。

如果是 Kubernetes 场景，再检查：

```bash
kubectl get nodes
kubectl get pods -A -o wide
```

以及相关应用是否还能正常访问 CephFS。

最终判断标准不能只有：

```text
Ceph HEALTH_OK
```

还应该包括：

```text
客户端重新正常 mount
业务读写正常
没有新的 MDS warning
```

# 13. 我现在会按这个顺序处理

```text
ceph status
    ↓
HEALTH_WARN:
client failing to respond to capability release
    ↓
ceph health detail
    ↓
拿到 MDS name + client ID
    ↓
ceph tell mds.<name> client ls
    ↓
确认 client / hostname / node
    ↓
检查节点、CSI、业务状态
    ↓
client 是否仍是合法使用者？
 ├─ 是
 │   ↓
 │  查 client / network / MDS / RADOS 原因
 │
 └─ 否，或 client 已异常且无法正常清理
     ↓
     client evict
     ↓
     fresh mount
     ↓
     ceph status + 业务 I/O 验证
```

# 总结

这次问题最后只用了一条强制处理命令：

```bash
ceph tell mds.<mds-name> client evict id=<client-id>
```

但真正重要的是不要把它理解成：

```text
CephFS 出 warning 的万能修复命令
```

`MDS_CLIENT_LATE_RELEASE` 告诉我们：

```text
某个 client 没有及时释放 capability
```

`MDS_SLOW_REQUEST` 告诉我们：

```text
MDS 上存在长时间未完成的请求
```

两者同时出现时，一个异常 client 的确值得优先排查。

但在执行 eviction 前，仍然应该先确认 client 身份和业务状态。

因为：

> **驱逐 CephFS client 是 fencing 操作，不只是清理一条 session；如果还有未刷新的 buffered I/O，可能产生数据损失。**

这也是这次故障记录里，比“最后哪条命令让 HEALTH_WARN 消失”更值得留下来的部分。

## References

- Ceph Documentation — CephFS Health Messages  
  https://docs.ceph.com/en/latest/cephfs/health-messages/
- Ceph Documentation — CephFS Client Eviction  
  https://docs.ceph.com/en/latest/cephfs/eviction/
