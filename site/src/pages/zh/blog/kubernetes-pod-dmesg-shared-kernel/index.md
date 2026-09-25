---
layout: ../../../../layouts/ArticleLayout.astro
title: "Kubernetes Pod 里的 dmesg 为什么和宿主机一样？理解容器共享内核与 dmesg_restrict"
description: "解释为什么 Kubernetes Pod 中执行 dmesg 会看到宿主机内核日志，以及 kernel.dmesg_restrict、CAP_SYSLOG、CAP_SYS_ADMIN 与容器隔离之间的关系。"
pubDate: "2026-09-19"
category: Kubernetes
tags:
  - Kubernetes
  - Linux
  - Containers
  - Security
enPath: "/blog/kubernetes-pod-dmesg-shared-kernel/"
zhPath: "/zh/blog/kubernetes-pod-dmesg-shared-kernel/"
---

在 Kubernetes 中，Pod 看起来拥有独立的文件系统、进程、网络和运行环境，因此第一次在 Pod 内执行 `dmesg` 时，很多人都会产生一个疑问：

> Pod 不是和宿主机隔离的吗？为什么 Pod 里看到的 `dmesg` 和宿主机几乎一样？

原因并不是 Kubernetes 的隔离失效了，而是 **Linux 容器并不会启动一套独立内核**。

Pod 中的进程仍然运行在宿主机的 Linux 内核之上。`dmesg` 读取的是内核日志缓冲区，而这个缓冲区属于宿主机内核，并不是某个 Pod 私有的日志。

---

## 1. 容器隔离了什么，又没有隔离什么？

容器主要依靠 Linux Namespace、cgroup、Capabilities、seccomp、LSM 等机制实现隔离。

常见的 Namespace 包括：

- PID Namespace：隔离进程 ID 视图
- Network Namespace：隔离网络设备、路由表和端口
- Mount Namespace：隔离挂载点和文件系统视图
- IPC Namespace：隔离 System V IPC、POSIX 消息队列等
- UTS Namespace：隔离 hostname 和 domain name

但是容器与宿主机仍然共享同一个 Linux Kernel。

可以简单理解为：

```text
Node
└── Linux Kernel
    ├── Pod A
    │   └── Container
    ├── Pod B
    │   └── Container
    └── Host Processes
```

Pod A、Pod B 和宿主机进程看到的用户空间环境可以不同，但最终都在调用同一套宿主机内核。

因此，在同一个 Node 上比较：

```bash
uname -r
```

以及：

```bash
kubectl exec -it <pod> -- uname -r
```

通常会看到相同的内核版本。

---

## 2. 为什么 Pod 里的 dmesg 会看到宿主机日志？

`dmesg` 用于读取 Linux Kernel 的消息缓冲区，其中可能包含：

```text
Linux version ...
Command line ...
CPU initialization ...
Memory information ...
Network driver messages ...
Disk and filesystem messages ...
Kernel warnings and errors ...
```

这些信息来自内核本身。

它并不属于：

```text
Pod A
```

也不属于：

```text
Pod B
```

而是属于：

```text
这个 Node 正在运行的 Linux Kernel
```

所以，只要 Pod 中的进程拥有读取 Kernel Log Buffer 的权限，就可能看到与宿主机相同或高度一致的 `dmesg` 内容。

这也是为什么 `dmesg` **不能被理解成 Pod 日志**。

查看应用日志通常应该使用：

```bash
kubectl logs <pod>
```

而 `dmesg` 更适合排查 Node 级别的内核、驱动、内存、磁盘、网络设备等问题。

---

## 3. kernel.dmesg_restrict 控制什么？

Linux 提供了：

```text
kernel.dmesg_restrict
```

用于限制非特权进程读取内核日志。

查看当前值：

```bash
sysctl kernel.dmesg_restrict
```

或者：

```bash
cat /proc/sys/kernel/dmesg_restrict
```

常见值：

| 值 | 含义 |
|---|---|
| `0` | 不额外限制非特权进程读取内核日志 |
| `1` | 读取内核日志需要相应的特权 Capability |

Linux Kernel 文档明确说明：当 `kernel.dmesg_restrict=1` 时，读取 `dmesg` 需要 `CAP_SYSLOG`。

需要注意，容器运行时、seccomp、AppArmor/SELinux 以及 Kubernetes 安全策略仍然可能施加额外限制。因此，`dmesg_restrict=0` 并不意味着所有 Kubernetes 环境中的 Pod 都一定能够读取 `dmesg`。

---

## 4. 实验一：kernel.dmesg_restrict=0

以下示例固定 Pod 到指定 Node：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ubuntu-dmesg
spec:
  nodeSelector:
    kubernetes.io/hostname: "172.31.1.127"
  containers:
    - name: ubuntu
      image: ubuntu:20.04
      command: ["sh", "-c", "sleep infinity"]
```

创建：

```bash
kubectl apply -f ubuntu-dmesg.yaml
```

查看内核参数：

```bash
kubectl exec -it ubuntu-dmesg -- sysctl kernel.dmesg_restrict
```

例如：

```text
kernel.dmesg_restrict = 0
```

再执行：

```bash
kubectl exec -it ubuntu-dmesg -- dmesg | head -n 2
```

可能看到：

```text
[    0.000000] Linux version 5.4.0-147-generic ...
[    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz-5.4.0-147-generic ...
```

这就是 Node 内核启动阶段产生的信息，而不是 Pod 启动时产生的日志。

---

## 5. 实验二：kernel.dmesg_restrict=1

当宿主机设置：

```text
kernel.dmesg_restrict = 1
```

普通 Pod 再执行：

```bash
kubectl exec -it ubuntu-dmesg -- dmesg | head
```

可能得到：

```text
dmesg: read kernel buffer failed: Operation not permitted
command terminated with exit code 1
```

此时 Pod 内查看：

```bash
kubectl exec -it ubuntu-dmesg -- sysctl kernel.dmesg_restrict
```

也可能看到：

```text
kernel.dmesg_restrict = 1
```

这是因为 `kernel.dmesg_restrict` 控制的是宿主机内核行为，并不是为每个普通 Pod 提供一份独立值。

---

## 6. 如果确实需要在 Pod 中读取 dmesg

Linux Kernel 文档推荐的 Capability 是：

```text
CAP_SYSLOG
```

在 Kubernetes `securityContext` 中可以表示为：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ubuntu-dmesg-syslog
spec:
  nodeSelector:
    kubernetes.io/hostname: "172.31.1.127"
  containers:
    - name: ubuntu
      image: ubuntu:20.04
      command: ["sh", "-c", "sleep infinity"]
      securityContext:
        capabilities:
          add:
            - SYSLOG
```

然后测试：

```bash
kubectl exec -it ubuntu-dmesg-syslog -- dmesg | head
```

是否能够成功，还取决于容器运行时、seccomp、LSM 和 Kubernetes Admission / Pod Security 策略。

---

## 7. 为什么 CAP_SYS_ADMIN 也可能有效？

实际环境中可能会看到这样的配置：

```yaml
securityContext:
  capabilities:
    add:
      - SYS_ADMIN
```

然后 `dmesg` 可以成功读取。

这是有历史原因的。

Linux `syslog(2)` 文档说明，从 Linux 2.6.37 开始，`CAP_SYSLOG` 是执行特权 syslog 操作的专用 Capability；`CAP_SYS_ADMIN` 仍可能被接受，但用于这一目的已经被视为兼容性的旧做法。

因此：

```text
CAP_SYS_ADMIN 能工作
```

并不代表：

```text
为了读取 dmesg 就应该授予 CAP_SYS_ADMIN
```

`CAP_SYS_ADMIN` 权限范围非常广，经常被称为接近“新的 root”。如果需求只是读取内核日志，应优先考虑更小权限的 `CAP_SYSLOG`。

---

## 8. 为什么 Kubernetes 默认不应该让普通 Pod 随便读 dmesg？

Kernel Log 中可能包含：

- 内核版本
- 内核启动参数
- 硬件信息
- 内存布局相关信息
- 驱动和设备信息
- 文件系统错误
- 网络设备信息
- Kernel Warning / Oops
- 某些可能帮助攻击者了解宿主机的信息

因此从安全角度看：

```text
Pod 能读取宿主机 dmesg
```

意味着 Pod 获得了额外的 Node 级别信息。

生产环境通常应该遵循最小权限原则，而不是为了方便排障给业务 Pod 增加过高的 Capability。

如果确实需要排查 Node 内核问题，更合理的方式通常是：

- 登录 Node 排查
- 使用受控的运维/debug Pod
- 使用 Kubernetes Node Debug 能力
- 使用集中式 Node 日志和监控系统

---

## 9. 一个容易混淆的点：Pod 隔离 ≠ 虚拟机隔离

虚拟机通常拥有自己的 Guest Kernel：

```text
Physical Host
├── VM A
│   └── Guest Kernel A
└── VM B
    └── Guest Kernel B
```

而容器是：

```text
Physical / Virtual Host
└── Host Kernel
    ├── Container A
    ├── Container B
    └── Container C
```

因此：

```text
VM 里的 dmesg
```

通常对应 VM 自己的 Guest Kernel。

而：

```text
Container / Pod 里的 dmesg
```

如果有权限读取，则对应它所在 Node 的 Host Kernel。

这就是两者最核心的区别之一。

---

## 10. 总结

Pod 内执行 `dmesg` 能看到宿主机内核日志，并不是容器隔离失效，而是 Linux 容器架构本身决定的：

```text
容器隔离的是用户空间视图和资源
        ↓
容器并没有自己的独立 Kernel
        ↓
Pod 与 Node 共享宿主机 Kernel
        ↓
dmesg 读取 Kernel Log Buffer
        ↓
因此有权限时看到的是 Node 级内核日志
```

权限控制方面：

```text
kernel.dmesg_restrict=0
        ↓
内核本身不额外要求特权读取

kernel.dmesg_restrict=1
        ↓
需要特权 Capability
        ↓
优先使用 CAP_SYSLOG
```

如果 `CAP_SYS_ADMIN` 在某个环境中能够读取 `dmesg`，应把它理解为兼容行为，而不是推荐的最小权限配置。

---

## References

- Linux Kernel documentation — `/proc/sys/kernel/dmesg_restrict`: https://docs.kernel.org/admin-guide/sysctl/kernel.html
- Linux `syslog(2)` manual: https://man7.org/linux/man-pages/man2/syslog.2.html
- Linux capabilities manual: https://man7.org/linux/man-pages/man7/capabilities.7.html
