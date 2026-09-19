---
layout: ../../../layouts/ArticleLayout.astro
title: "Why Does dmesg Inside a Kubernetes Pod Show the Host Kernel Log?"
description: "Understand why dmesg inside a Kubernetes Pod can expose host kernel messages, and how kernel.dmesg_restrict, CAP_SYSLOG, CAP_SYS_ADMIN, and container isolation interact."
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

# Why Does dmesg Inside a Kubernetes Pod Show the Host Kernel Log?

Kubernetes Pods provide isolated process, filesystem, network, and runtime environments. Because of that, seeing the same `dmesg` output inside a Pod and on the host can be surprising:

> If the Pod is isolated from the host, why can it see host kernel messages?

The answer is that **Linux containers do not boot their own kernel**.

Processes inside a Pod still run on the Linux kernel of the Kubernetes node. `dmesg` reads the kernel message buffer, which belongs to that shared host kernel rather than to an individual Pod.

---

## 1. What containers isolate — and what they do not

Linux containers rely on mechanisms such as namespaces, cgroups, capabilities, seccomp, and Linux Security Modules.

Common namespaces include:

- PID namespace — process ID isolation
- Network namespace — interfaces, routes, and port isolation
- Mount namespace — filesystem mount isolation
- IPC namespace — IPC isolation
- UTS namespace — hostname and domain-name isolation

However, all containers on the same node still use the same Linux kernel.

A simplified view looks like this:

```text
Node
└── Linux Kernel
    ├── Pod A
    │   └── Container
    ├── Pod B
    │   └── Container
    └── Host Processes
```

The user-space view can differ between Pods, but system calls from all of those processes ultimately reach the same host kernel.

For example, compare:

```bash
uname -r
```

on the node with:

```bash
kubectl exec -it <pod> -- uname -r
```

They will normally report the same kernel version.

---

## 2. Why does dmesg show node-level information?

`dmesg` reads messages emitted by the Linux kernel.

Those messages may contain:

```text
Linux version ...
Command line ...
CPU initialization ...
Memory information ...
Network driver messages ...
Disk and filesystem messages ...
Kernel warnings and errors ...
```

These messages do not belong to Pod A or Pod B. They belong to the kernel running the node.

Therefore, if a process inside a Pod has permission to read the kernel log buffer, it can see node-level kernel messages that are the same as, or very similar to, what is visible on the host.

This is also why `dmesg` should not be considered a Pod log.

For application logs, use:

```bash
kubectl logs <pod>
```

`dmesg` is primarily useful for node-level kernel, driver, memory, disk, and device troubleshooting.

---

## 3. What does kernel.dmesg_restrict do?

Linux exposes the sysctl:

```text
kernel.dmesg_restrict
```

Check its current value with:

```bash
sysctl kernel.dmesg_restrict
```

or:

```bash
cat /proc/sys/kernel/dmesg_restrict
```

Typical behavior:

| Value | Meaning |
|---|---|
| `0` | The kernel does not add an extra privilege requirement for reading the kernel log |
| `1` | Reading the kernel log requires the appropriate privileged capability |

Linux kernel documentation states that when `kernel.dmesg_restrict=1`, access to `dmesg` requires `CAP_SYSLOG`.

Container runtimes, seccomp profiles, AppArmor/SELinux, and Kubernetes security policies can still impose additional restrictions. Therefore, `dmesg_restrict=0` does not guarantee that every Pod in every Kubernetes environment can read `dmesg`.

---

## 4. Experiment: kernel.dmesg_restrict=0

The following example schedules a test Pod onto a specific node:

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

Apply it:

```bash
kubectl apply -f ubuntu-dmesg.yaml
```

Check the sysctl from inside the Pod:

```bash
kubectl exec -it ubuntu-dmesg -- sysctl kernel.dmesg_restrict
```

For example:

```text
kernel.dmesg_restrict = 0
```

Now run:

```bash
kubectl exec -it ubuntu-dmesg -- dmesg | head -n 2
```

You may see output such as:

```text
[    0.000000] Linux version 5.4.0-147-generic ...
[    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz-5.4.0-147-generic ...
```

These are node kernel boot messages, not messages generated when the Pod started.

---

## 5. Experiment: kernel.dmesg_restrict=1

If the node has:

```text
kernel.dmesg_restrict = 1
```

a normal Pod may fail with:

```bash
kubectl exec -it ubuntu-dmesg -- dmesg | head
```

Result:

```text
dmesg: read kernel buffer failed: Operation not permitted
command terminated with exit code 1
```

Inside the Pod:

```bash
kubectl exec -it ubuntu-dmesg -- sysctl kernel.dmesg_restrict
```

may also show:

```text
kernel.dmesg_restrict = 1
```

The setting controls host-kernel behavior; it is not an independent per-Pod kernel setting.

---

## 6. If a Pod really needs to read dmesg

The capability intended for privileged kernel log access is:

```text
CAP_SYSLOG
```

In a Kubernetes security context:

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

Then test:

```bash
kubectl exec -it ubuntu-dmesg-syslog -- dmesg | head
```

Whether this succeeds also depends on the container runtime, seccomp profile, LSM policy, and Kubernetes admission or Pod Security policy.

---

## 7. Why can CAP_SYS_ADMIN also work?

You may encounter configurations such as:

```yaml
securityContext:
  capabilities:
    add:
      - SYS_ADMIN
```

where `dmesg` becomes readable.

There is a historical reason for this.

The Linux `syslog(2)` documentation explains that since Linux 2.6.37, `CAP_SYSLOG` is the dedicated capability for privileged syslog operations. `CAP_SYS_ADMIN` can still be accepted for compatibility, but it is deprecated for this purpose.

Therefore:

```text
CAP_SYS_ADMIN works
```

does not mean:

```text
CAP_SYS_ADMIN is the recommended permission for dmesg
```

`CAP_SYS_ADMIN` grants a very broad set of privileges and is often described as close to a "new root". If the only requirement is kernel-log access, the narrower `CAP_SYSLOG` is preferable.

---

## 8. Why should normal application Pods not read dmesg?

Kernel logs may expose information such as:

- kernel version
- boot parameters
- hardware details
- driver and device information
- filesystem errors
- networking details
- kernel warnings or Oops messages
- other node-level information useful to an attacker

Allowing an application Pod to read host `dmesg` therefore exposes additional node-level information.

Production environments should generally follow the principle of least privilege rather than granting broad capabilities to normal workloads.

For node-level kernel troubleshooting, better options usually include:

- troubleshooting directly on the node
- a controlled operations/debug Pod
- Kubernetes node debugging facilities
- centralized node logging and monitoring

---

## 9. Pod isolation is not VM isolation

A virtual machine normally has its own guest kernel:

```text
Physical Host
├── VM A
│   └── Guest Kernel A
└── VM B
    └── Guest Kernel B
```

Containers instead look more like:

```text
Physical / Virtual Host
└── Host Kernel
    ├── Container A
    ├── Container B
    └── Container C
```

Therefore:

```text
dmesg inside a VM
```

normally reflects the VM's guest kernel.

But:

```text
dmesg inside a container or Pod
```

when permitted, reflects the kernel of the node hosting that container.

That is one of the fundamental architectural differences between containers and virtual machines.

---

## 10. Summary

Seeing host kernel messages from `dmesg` inside a Kubernetes Pod does not mean container isolation has failed.

The behavior follows directly from the Linux container architecture:

```text
Containers isolate user-space views and resources
        ↓
Containers do not have their own independent kernel
        ↓
Pods share the node's Linux kernel
        ↓
dmesg reads the kernel log buffer
        ↓
A permitted Pod therefore sees node-level kernel messages
```

For access control:

```text
kernel.dmesg_restrict=0
        ↓
No additional kernel privilege requirement

kernel.dmesg_restrict=1
        ↓
Privileged capability required
        ↓
Prefer CAP_SYSLOG
```

If `CAP_SYS_ADMIN` works in a particular environment, treat that as a compatibility behavior rather than the preferred least-privilege configuration.

---

## References

- Linux Kernel documentation — `/proc/sys/kernel/dmesg_restrict`: https://docs.kernel.org/admin-guide/sysctl/kernel.html
- Linux `syslog(2)` manual: https://man7.org/linux/man-pages/man2/syslog.2.html
- Linux capabilities manual: https://man7.org/linux/man-pages/man7/capabilities.7.html
