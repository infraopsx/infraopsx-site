/**
 * Editorially selected reading paths between existing troubleshooting guides.
 *
 * Keep this mapping small and topical: it is navigation for readers, not a
 * keyword/link-count optimization. Every target must be a published article
 * in both languages. SEO E2E verifies that generated links resolve.
 */
type Language = 'en' | 'zh';

const labels: Record<string, Record<Language, string>> = {
  'cephfs-client-late-release-mds-slow-request': {
    en: 'CephFS MDS client late release and slow requests',
    zh: 'CephFS MDS_CLIENT_LATE_RELEASE 与慢请求'
  },
  'cephfs-mds-damaged-filesystem-offline-recovery': {
    en: 'CephFS filesystem offline and damaged MDS recovery',
    zh: 'CephFS filesystem offline 与 MDS damaged 恢复'
  },
  'etcd-backup-and-restore-on-kubernetes': {
    en: 'Kubernetes etcd backup and three-member restore',
    zh: 'Kubernetes etcd 备份与三节点恢复'
  },
  'etcd-nospace-alarm-troubleshooting': {
    en: 'etcd NOSPACE quota, compaction and defrag',
    zh: 'etcd NOSPACE、压缩与碎片整理'
  },
  'kubeadm-kubernetes-v1-27-to-v1-30-upgrade': {
    en: 'kubeadm upgrade from Kubernetes v1.27 to v1.30',
    zh: 'kubeadm 从 Kubernetes v1.27 升级到 v1.30'
  },
  'kubernetes-ceph-rbd-high-iowait-latency': {
    en: 'Kubernetes high iowait and Ceph RBD latency',
    zh: 'Kubernetes 高 iowait 与 Ceph RBD 延迟'
  },
  'kubernetes-evicted-pod-error-containerstatusunknown': {
    en: 'Evicted Pods showing Error or ContainerStatusUnknown',
    zh: 'Evicted Pod 显示 Error 或 ContainerStatusUnknown'
  },
  'kubernetes-hpa-cpu-resource-containerresource': {
    en: 'Kubernetes HPA CPU requests and scaling behavior',
    zh: 'Kubernetes HPA CPU requests 与扩缩容'
  },
  'kubernetes-node-notready-pod-not-rescheduled': {
    en: 'Why Pods are not rescheduled after Node NotReady',
    zh: 'Node NotReady 后 Pod 为何没有重新调度'
  },
  'kubernetes-pod-dmesg-shared-kernel': {
    en: 'Why Pod dmesg shows the host kernel log',
    zh: '为什么 Pod dmesg 能看到宿主机内核日志'
  },
  'kubernetes-pod-pending': {
    en: 'Kubernetes Pod Pending troubleshooting',
    zh: 'Kubernetes Pod Pending 排查流程'
  },
  'postgresql-daily-operations-psql-admin': {
    en: 'PostgreSQL daily administration with psql',
    zh: 'PostgreSQL psql 日常运维命令'
  },
  'postgresql-pg-wal-growth-patroni-replication-lag': {
    en: 'PostgreSQL pg_wal growth and Patroni replica lag',
    zh: 'PostgreSQL pg_wal 增长与 Patroni 副本延迟'
  },
  'rook-ceph-osd-high-memory-osd-memory-target': {
    en: 'Rook Ceph OSD memory and osd_memory_target',
    zh: 'Rook Ceph OSD 内存与 osd_memory_target'
  },
  'rook-ceph-rbd-image-still-being-used-failedmount': {
    en: 'Rook Ceph RBD FailedMount: image still in use',
    zh: 'Rook Ceph RBD FailedMount：镜像仍被使用'
  }
};

const related: Record<string, readonly string[]> = {
  'cephfs-client-late-release-mds-slow-request': [
    'cephfs-mds-damaged-filesystem-offline-recovery',
    'rook-ceph-osd-high-memory-osd-memory-target'
  ],
  'cephfs-mds-damaged-filesystem-offline-recovery': [
    'cephfs-client-late-release-mds-slow-request',
    'rook-ceph-osd-high-memory-osd-memory-target'
  ],
  'etcd-backup-and-restore-on-kubernetes': [
    'etcd-nospace-alarm-troubleshooting',
    'kubeadm-kubernetes-v1-27-to-v1-30-upgrade'
  ],
  'etcd-nospace-alarm-troubleshooting': [
    'etcd-backup-and-restore-on-kubernetes',
    'kubeadm-kubernetes-v1-27-to-v1-30-upgrade'
  ],
  'kubeadm-kubernetes-v1-27-to-v1-30-upgrade': [
    'etcd-backup-and-restore-on-kubernetes',
    'kubernetes-node-notready-pod-not-rescheduled'
  ],
  'kubernetes-ceph-rbd-high-iowait-latency': [
    'rook-ceph-osd-high-memory-osd-memory-target',
    'rook-ceph-rbd-image-still-being-used-failedmount'
  ],
  'kubernetes-evicted-pod-error-containerstatusunknown': [
    'kubernetes-node-notready-pod-not-rescheduled',
    'kubernetes-pod-pending'
  ],
  'kubernetes-hpa-cpu-resource-containerresource': [
    'kubernetes-pod-pending',
    'kubernetes-evicted-pod-error-containerstatusunknown'
  ],
  'kubernetes-node-notready-pod-not-rescheduled': [
    'kubernetes-evicted-pod-error-containerstatusunknown',
    'kubernetes-pod-pending'
  ],
  'kubernetes-pod-dmesg-shared-kernel': [
    'kubernetes-node-notready-pod-not-rescheduled',
    'kubernetes-evicted-pod-error-containerstatusunknown'
  ],
  'kubernetes-pod-pending': [
    'kubernetes-node-notready-pod-not-rescheduled',
    'kubernetes-evicted-pod-error-containerstatusunknown'
  ],
  'postgresql-daily-operations-psql-admin': [
    'postgresql-pg-wal-growth-patroni-replication-lag'
  ],
  'postgresql-pg-wal-growth-patroni-replication-lag': [
    'postgresql-daily-operations-psql-admin'
  ],
  'rook-ceph-osd-high-memory-osd-memory-target': [
    'kubernetes-ceph-rbd-high-iowait-latency',
    'rook-ceph-rbd-image-still-being-used-failedmount'
  ],
  'rook-ceph-rbd-image-still-being-used-failedmount': [
    'kubernetes-ceph-rbd-high-iowait-latency',
    'rook-ceph-osd-high-memory-osd-memory-target'
  ]
};

export function relatedArticlesForPath(path: string, language: Language) {
  const slug = path.match(/^\/(?:zh\/)?blog\/([^/]+)\/$/)?.[1];
  if (!slug) return [];

  return (related[slug] ?? [])
    .filter((target) => target !== slug && Boolean(labels[target]))
    .map((target) => ({
      href: language === 'zh' ? '/zh/blog/' + target + '/' : '/blog/' + target + '/',
      title: labels[target][language]
    }));
}
