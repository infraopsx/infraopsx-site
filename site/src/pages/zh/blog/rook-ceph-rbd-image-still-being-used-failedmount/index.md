---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes + Rook Ceph：FailedMount 提示 RBD image is still being used 怎么排查"
description: "一次 Rook Ceph RBD PVC 挂载失败的真实排障记录：从 FailedMount、CSI nodeplugin、rbd device list、watcher 到 blocklist，梳理 still being used 的判断逻辑和安全恢复顺序。"
pubDate: "2026-09-19"
category: Storage
tags:
  - Kubernetes
  - Rook
  - Ceph
  - RBD
  - CSI
  - Troubleshooting
enPath: "/blog/rook-ceph-rbd-image-still-being-used-failedmount/"
zhPath: "/zh/blog/rook-ceph-rbd-image-still-being-used-failedmount/"
---

这类问题我以前碰到过一次，Pod 一直卡在 `ContainerCreating`，`kubectl describe pod` 里反复出现：

```text
Warning  FailedMount  kubelet

MountVolume.MountDevice failed for volume "pvc-xxxxxxxx":
rpc error: code = Internal desc =
rbd image ceph-blockpool/csi-vol-xxxxxxxx is still being used
```

当时参考了几个 Rook issue，最后的处理思路是：

```text
找到 RBD image 到底还映射在哪个节点
        ↓
确认旧挂载已经不再被业务使用
        ↓
umount
        ↓
rbd unmap
        ↓
让 CSI 重新完成挂载
```

这次重新整理以后，我发现真正应该记住的并不是那几条命令，而是：

> **`is still being used` 是一个数据保护信号。先找到“谁还在使用”，再决定是否清理。**

如果还没搞清楚旧客户端到底活没活，就直接删 `VolumeAttachment`、强制 unmap 或 blocklist，都可能把一个本来只是“挂不上”的问题变成双写或文件系统损坏。

如果想先看这次故障的简化闭环，可以阅读 [Rook Ceph RBD FailedMount 案例](/zh/case-studies/rook-ceph-rbd-failedmount/)。

> 文中的 PVC、RBD image、节点名和地址都使用通用示例，不对应真实生产环境。

## 这个报错是什么意思

RBD 通常被用作 Kubernetes 的 `ReadWriteOnce` 块存储。

Pod 从旧节点迁到新节点时，理想流程是：

```text
旧 Pod 停止
        ↓
旧节点 unmount
        ↓
旧节点 unmap RBD
        ↓
CSI 完成 detach
        ↓
新节点 map
        ↓
mount
        ↓
新 Pod Running
```

如果旧节点异常断网、重启、Kubelet 卡住，或者 CSI 的清理流程没有完成，就可能变成：

```text
Ceph / CSI 仍然认为旧客户端在使用 RBD
        ↓
新节点尝试 map / mount
        ↓
CSI 为了避免两个节点同时写同一块盘而拒绝
        ↓
rbd image ... is still being used
```

所以这个错误本身其实是在保护数据。

---

## 第一步：先确认失败的是哪个 Pod、PVC 和节点

先看 Pod：

```bash
kubectl -n app get pod app-0 -o wide
```

记录：

```text
Pod
Node
PVC
```

再看事件：

```bash
kubectl -n app describe pod app-0
```

重点找：

```text
FailedMount
MountVolume.MountDevice
rbd image ... is still being used
```

如果错误信息已经明确给出了：

```text
ceph-blockpool/csi-vol-xxxxxxxx
```

后面可以直接围绕这个 image 查。

同时确认 PVC / PV：

```bash
kubectl -n app get pvc data-app-0 -o wide
kubectl get pv <pv-name> -o yaml
```

以及 VolumeAttachment：

```bash
kubectl get volumeattachment
```

如果集群里对象很多：

```bash
kubectl get volumeattachment -o yaml | grep -B5 -A10 '<pv-name>'
```

这里主要是在回答：

```text
Kubernetes 现在认为这个卷应该挂在哪个节点？
```

但要注意：

> `VolumeAttachment` 只是 Kubernetes / CSI 控制面的状态，不等于底层 RBD 一定已经完全 detach。

---

## 第二步：先找应用 Pod 所在节点对应的 CSI RBD plugin

Rook 的 `csi-rbdplugin` 是 DaemonSet，正常情况下每个可使用 RBD 的节点都会有一个 nodeplugin Pod。

先看：

```bash
kubectl -n rook-ceph get pod -o wide | grep csi-rbdplugin
```

找到应用 Pod 当前所在节点对应的 `csi-rbdplugin-xxxxx`。

然后看日志：

```bash
kubectl -n rook-ceph logs \
  csi-rbdplugin-xxxxx \
  -c csi-rbdplugin \
  --since=30m
```

如果日志里一直出现：

```text
is still being used
```

再继续往 RBD 层查。

---

## 第三步：查所有 nodeplugin 上的 RBD 映射

我当时用的是：

```bash
for pod in $(kubectl -n rook-ceph get pods \
  | grep rbdplugin \
  | grep -v provisioner \
  | awk '{print $1}'); do
    echo "===== $pod ====="
    kubectl -n rook-ceph exec "$pod" -c csi-rbdplugin -- rbd device list
done
```

会看到类似：

```text
===== csi-rbdplugin-node-a =====
id  pool            namespace  image                  snap  device
0   ceph-blockpool             csi-vol-aaaa           -     /dev/rbd0
1   ceph-blockpool             csi-vol-bbbb           -     /dev/rbd1

===== csi-rbdplugin-node-b =====
id  pool            namespace  image                  snap  device
0   ceph-blockpool             csi-vol-cccc           -     /dev/rbd0
```

现在就找目标 image：

```text
csi-vol-xxxxxxxx
```

### 为什么一定要在 nodeplugin 上查

这是我第一次处理时容易混淆的地方。

RBD 映射发生在：

```text
实际使用这个卷的 Kubernetes 节点
```

所以：

```text
rook-ceph-tools
```

里执行：

```bash
rbd device list
```

看不到目标 image，并不能说明整个集群都没映射。

Rook issue 里维护者也明确提醒过：

```text
要去真正 mapped 的节点处理，不是在 toolbox Pod 里随便 unmap。
```

---

# 情况一：找到了旧映射

假设在：

```text
csi-rbdplugin-node-a
```

发现：

```text
ceph-blockpool/csi-vol-xxxxxxxx
→ /dev/rbd5
```

先进入这个 nodeplugin：

```bash
kubectl -n rook-ceph exec -it \
  csi-rbdplugin-node-a \
  -c csi-rbdplugin -- sh
```

## 先确认设备到底有没有 mount

比单纯 `mount | grep` 更清楚一点：

```bash
findmnt /dev/rbd5
```

也可以：

```bash
mount | grep '/dev/rbd5'
```

再看设备：

```bash
lsblk /dev/rbd5
```

如果工具可用，还可以检查是否仍有进程打开：

```bash
fuser -vm /dev/rbd5
```

这一步要回答：

> **它是真的还被业务使用，还是旧 Pod 已经没了，但映射残留？**

---

## 确认旧业务已经停止后再 umount

如果确实还有挂载点，例如：

```text
/dev/rbd5 on /var/lib/kubelet/plugins/kubernetes.io/csi/...
```

先确认旧 Pod 已经停止，而且没有程序还在读写这个文件系统。

然后：

```bash
umount <mount-point>
```

不要为了省事一上来就：

```bash
umount -l
```

或者强制卸载。

普通 `umount` 失败时先看是谁占用，原因比“让它赶紧消失”更重要。

---

## 再 unmap

可以使用设备：

```bash
rbd device unmap /dev/rbd5
```

也可以使用 image spec：

```bash
rbd device unmap ceph-blockpool/csi-vol-xxxxxxxx
```

旧版本常见写法：

```bash
rbd unmap /dev/rbd5
```

这里有一个常见错误。

不要拼成：

```text
/dev/rbd5/ceph-blockpool/csi-vol-xxxxxxxx
```

`/dev/rbd5` 本身就是 block device。

---

## `--force` 不是第一选择

Ceph 支持强制 unmap：

```bash
rbd device unmap --options force /dev/rbd5
```

或者某些版本：

```bash
rbd unmap -o force /dev/rbd5
```

但它的含义不是“更厉害的正常 unmap”。

Force unmap 可以对仍处于 open 状态的 block device 发起强制解除，后续请求会失败。

所以我只会在已经确认：

```text
旧工作负载已经停止
没有合法写入者
普通 unmap 因残留状态无法完成
```

以后才考虑。

---

# 情况二：所有 nodeplugin 都找不到 mapping，但 `rbd status` 有 watcher

这就是更麻烦、也更值得记录的情况。

先查：

```bash
rbd status ceph-blockpool/csi-vol-xxxxxxxx
```

例如：

```text
Watchers:
    watcher=192.0.2.21:0/123456789
    client.12345
    cookie=18446462598732840000
```

如果：

```text
rbd device list
```

到处都找不到这个 image，

但：

```text
rbd status
```

仍然有 watcher，

就很像是：

```text
旧客户端 / 旧节点留下了 stale watcher
```

Rook 的历史 issue 里就有完全相同的情况：nodeplugin 中已经找不到映射，但 `rbd status` 还能看到旧 watcher。

---

## watcher 和 `rbd lock ls` 不是一回事

遇到这个问题时有人会查：

```bash
rbd lock ls ceph-blockpool/csi-vol-xxxxxxxx
```

结果可能为空。

这并不能证明：

```text
没人使用这个 image
```

因为：

```text
RBD watcher
```

和：

```text
RBD advisory lock
```

不是完全相同的状态。

所以这类 `still being used`，我首先看：

```bash
rbd status
```

而不是只看：

```bash
rbd lock ls
```

---

# stale watcher：先确定旧客户端是不是真的死了

假设：

```bash
rbd status ceph-blockpool/csi-vol-xxxxxxxx
```

给出：

```text
watcher=192.0.2.21:0/123456789
```

下一步不是立刻 blocklist。

先回答：

```text
这个地址是谁？
旧 Kubernetes 节点还活着吗？
上面是否还可能有旧 Pod 或 RBD mapping？
节点只是网络暂时断了，还是确定已经失联？
```

可以对照：

```bash
kubectl get nodes -o wide
kubectl get pods -A -o wide
```

再检查对应节点。

这里最危险的是：

```text
旧节点其实还活着
        +
管理员以为它死了
        +
新节点又把同一个 RWO RBD 挂起来
        =
潜在双写
```

所以 **fencing 比“让 Pod 快点起来”更重要**。

---

# 确认旧客户端不能再写后，再考虑 blocklist

Rook 官方的 CSI troubleshooting 文档把这种 node loss 场景单独列了出来。

对于较新的 Ceph：

```bash
ceph osd blocklist add <client-address>
```

例如使用 `rbd status` 中看到的完整 watcher endpoint：

```bash
ceph osd blocklist add 192.0.2.21:0/123456789
```

有些场景也会按节点 IP 进行 blocklist，具体以当前 Rook / Ceph 版本的 fencing 流程为准。

blocklist 的意义是：

```text
拒绝旧 Ceph client 再访问集群
        ↓
把旧 writer fence 掉
        ↓
新节点才可以安全接管 RBD
```

所以它不是：

```text
“删除一条讨厌的 watcher”
```

而是：

> **先阻止旧客户端继续访问存储，再允许新客户端接管。**

---

## `blocklist` 和旧版本的 `blacklist`

版本不同，命令名字也变过。

Ceph Pacific 及之后常见：

```bash
ceph osd blocklist add <address>
ceph osd blocklist ls
ceph osd blocklist rm <address>
```

更老的版本可能还是：

```bash
ceph osd blacklist add <address>
ceph osd blacklist ls
ceph osd blacklist rm <address>
```

所以如果：

```bash
ceph osd blocklist add ...
```

提示：

```text
no valid command found
```

先确认：

```bash
ceph -v
```

不要直接判断成“Ceph 不支持 fencing”。

---

## 不要刚 blocklist 就马上 rm

这个也要特别注意。

例如：

```bash
ceph osd blocklist add 192.0.2.21:0/123456789
```

新 Pod 成功恢复后，并不代表下一秒就一定应该：

```bash
ceph osd blocklist rm ...
```

先确认：

```text
旧节点确实不会重新带着旧 mapping 回来
旧客户端已经失效
新 Pod 已稳定挂载
没有双写风险
```

如果旧节点发生过失联，最安全的做法通常是确保它完成真正的 fencing / power cycle，再让它重新参与工作。

现代 Rook 还有基于 Kubernetes `node.kubernetes.io/out-of-service` taint 和 CSI fencing 的处理方式。对于支持这套机制的新集群，优先按当前 Rook 文档执行，不要继续照搬很多年前 issue 里的手工步骤。

---

# 情况三：没有 mapping，也没有 watcher

如果：

```bash
rbd device list
```

找不到，

同时：

```bash
rbd status ceph-blockpool/csi-vol-xxxxxxxx
```

也是：

```text
Watchers: none
```

那就不要继续围绕“旧 RBD 还被占用”死磕。

去看 CSI 自己是不是卡住了。

Rook 当前的 CSI troubleshooting 文档建议检查 nodeplugin 中是否有卡死的：

```text
rbd map
rbd unmap
mkfs
mount
umount
```

进入应用所在节点的 plugin：

```bash
kubectl -n rook-ceph exec -it \
  csi-rbdplugin-xxxxx \
  -c csi-rbdplugin -- sh
```

然后：

```bash
ps -ef | grep '[r]bd'
ps -ef | grep '[m]ount'
ps -ef | grep '[u]mount'
ps -ef | grep '[m]kfs'
```

同时看：

```bash
dmesg
```

以及 CSI 日志。

如果确认只是 CSI nodeplugin 自己的状态卡住，重启**出问题节点对应的** `csi-rbdplugin` Pod 有时就能恢复。

这里我不会一上来重启所有 CSI Pod。

---

# 为什么不建议先删 VolumeAttachment

碰到：

```text
still being used
```

时很容易想到：

```bash
kubectl delete volumeattachment ...
```

但这只能改 Kubernetes API 里的 attachment 状态。

如果底层实际上还有：

```text
旧 RBD mapping
旧 mount
旧 watcher
仍能写 Ceph 的旧节点
```

删掉对象并不会自动让这些东西安全消失。

所以我现在把排查分成三层：

```text
Kubernetes 层
VolumeAttachment / Pod / Node

CSI Node 层
mount / rbd device mapping / stale operation

Ceph 层
RBD watcher / client fencing
```

三层状态对应起来以后再处理。

---

# 原来的处理为什么有效

我当时的记录里，先扫描所有 RBD nodeplugin：

```bash
for pod in $(kubectl -n rook-ceph get pods \
  | grep rbdplugin \
  | grep -v provisioner \
  | awk '{print $1}'); do
    echo "$pod"
    kubectl -n rook-ceph exec "$pod" \
      -c csi-rbdplugin -- rbd device list
done
```

找到了目标 image 后进入对应 plugin：

```bash
kubectl -n rook-ceph exec -it \
  csi-rbdplugin-xxxxx \
  -c csi-rbdplugin -- sh
```

然后：

```bash
mount | grep /dev/rbdX
umount <mount-point>
rbd unmap ceph-blockpool/csi-vol-xxxxxxxx
```

处理完以后 CSI 可以重新 map，Pod 恢复。

这个方法适用于：

```text
旧 mapping 确实还残留在某个节点
```

但现在再回头看，我不会把它写成所有 `still being used` 的通用答案。

因为另一个非常常见的情况是：

```text
mapping 已经不在
但 watcher 还在
```

这时真正应该查的是：

```bash
rbd status <pool>/<image>
```

然后根据旧客户端是否安全失效来决定是否 fencing / blocklist。

---

# reboot 为什么可能“有效”，但不应该是第一步

社区 issue 里还有一个很有代表性的现场：

```text
stale watcher
        ↓
节点重启
        ↓
watcher 消失
        ↓
新的挂载继续
        ↓
fsck 报文件系统不一致
```

这很好理解。

节点突然丢失时：

```text
RBD client
mount
filesystem journal
```

可能都没有正常收尾。

重启节点确实可能清掉旧 client 状态，但它不会保证文件系统层面一定干净。

所以如果恢复后出现：

```text
fsck found errors
UNEXPECTED INCONSISTENCY
```

那已经是另一个层次的问题：

```text
RBD 占用问题解决了
≠
文件系统一定没有损坏
```

不要继续用 `blocklist`、`unmap` 去“修 fsck”。

---

# 恢复后怎么验证

我至少检查下面这些。

## Pod

```bash
kubectl -n app get pod app-0 -o wide
```

应进入：

```text
Running
```

## Pod Event

```bash
kubectl -n app describe pod app-0
```

不再持续出现新的：

```text
FailedMount
is still being used
```

## RBD mapping

在新节点对应的 nodeplugin：

```bash
rbd device list
```

目标 image 应只出现在正确节点。

## Watcher

```bash
rbd status ceph-blockpool/csi-vol-xxxxxxxx
```

旧 client 不应该继续残留。

## VolumeAttachment

```bash
kubectl get volumeattachment
```

确认卷的 attachment 与当前 Pod 所在节点一致。

## 应用实际读写

最后从应用内部做真实读写验证。

不要只满足于：

```text
Pod = Running
```

对于数据库、消息队列这类有状态应用，还要确认它自己完成恢复，没有只是在容器层面启动成功。

---

# 下次我会直接按这个顺序查

```text
FailedMount:
rbd image ... is still being used
        ↓
1. 确认 Pod / PVC / PV / Node
        ↓
2. 看 VolumeAttachment
        ↓
3. 看应用节点的 csi-rbdplugin 日志
        ↓
4. 所有 nodeplugin 扫 rbd device list
        ↓
   找到 mapping？
   ├─ 是
   │   ↓
   │  查 mount / open process
   │   ↓
   │  确认旧业务已停止
   │   ↓
   │  umount → unmap
   │
   └─ 否
       ↓
       rbd status <pool>/<image>
       ↓
       有 watcher？
       ├─ 是
       │   ↓
       │  找到旧 client / node
       │   ↓
       │  确认已经安全失效
       │   ↓
       │  fencing / blocklist
       │
       └─ 否
           ↓
           查 CSI stale operation
           map / unmap / mount / umount / mkfs
           ↓
           dmesg + csi-rbdplugin logs
```

这个流程比我原来只记：

```text
找到 image
umount
unmap
```

完整得多。

---

# 几条我现在不会随便做的操作

```bash
rbd unmap -o force ...
```

不是第一步。

```bash
ceph osd blocklist add ...
```

不是看到 watcher 就执行。

```bash
ceph osd blocklist rm ...
```

不是新 Pod 一启动就执行。

```bash
kubectl delete volumeattachment ...
```

不是清理底层映射的替代品。

```bash
reboot <node>
```

也不是最便宜的 RBD 清理方式。

这几条命令都有可能是正确的，但前提是先知道当前故障到底处在哪一层。

---

# 最后记住三个点

第一：

> `rbd image is still being used` 通常不是“Ceph 坏了”，而是 CSI 不愿意在旧 client 状态没有处理清楚时把 RWO 卷交给另一个节点。

第二：

> `rbd device list` 查的是本地 mapping，`rbd status` 查 watcher。前者没有结果，不代表后者一定没有旧 client。

第三：

> blocklist 本质是 fencing，不是简单的“清 watcher”。只有确认旧客户端不能继续合法写这个 RBD 时，才应该使用。

把这三层分清以后：

```text
Kubernetes attachment
CSI node mapping
Ceph watcher
```

这类 `FailedMount` 就比较容易定位了。

## References

- Rook issue #4772 — FailedMount rbd image is still being used  
  https://github.com/rook/rook/issues/4772
- Rook issue #11372 — RBD image is still being used / stale watcher  
  https://github.com/rook/rook/issues/11372
- Rook issue #11201 — MountVolume.MountDevice and stale RBD state  
  https://github.com/rook/rook/issues/11201
- Rook — CSI Common Issues  
  https://github.com/rook/rook/blob/master/Documentation/Troubleshooting/ceph-csi-common-issues.md
- Rook — Block Storage / Node fencing  
  https://github.com/rook/rook/blob/master/Documentation/Storage-Configuration/Block-Storage-RBD/block-storage.md
- Ceph — RBD command reference  
  https://docs.ceph.com/en/latest/man/8/rbd/
