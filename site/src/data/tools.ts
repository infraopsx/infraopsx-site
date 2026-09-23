export const toolCategories = [
  'Calculator',
  'Converter',
  'Generator',
  'Validator',
  'Inspector'
] as const;

export type ToolCategory = (typeof toolCategories)[number];
export type ToolStatus = 'available' | 'planned';

type LocalizedText = {
  en: string;
  zh: string;
};

type LocalizedKeywords = {
  en: readonly string[];
  zh: readonly string[];
};

type ToolMetadata = {
  id: string;
  category: ToolCategory;
  featured: boolean;
  title: LocalizedText;
  description: LocalizedText;
  keywords: LocalizedKeywords;
};

type AvailableTool = ToolMetadata & {
  status: 'available';
  path: LocalizedText;
};

type PlannedTool = ToolMetadata & {
  status: 'planned';
  path: {
    en: null;
    zh: null;
  };
};

export type Tool = AvailableTool | PlannedTool;

export const toolsCatalog = [
  {
    id: 'ceph-capacity-calculator',
    category: 'Calculator',
    status: 'available',
    featured: true,
    title: {
      en: 'Ceph Capacity Calculator',
      zh: 'Ceph Capacity Calculator'
    },
    description: {
      en: 'Estimate raw capacity, theoretical usable capacity, and reserve headroom for replicated and erasure-coded Ceph layouts.',
      zh: '估算 Ceph 副本与 Erasure Coding 布局下的 Raw Capacity、Usable Capacity 和预留空间。'
    },
    path: {
      en: '/tools/ceph-capacity-calculator/',
      zh: '/zh/tools/ceph-capacity-calculator/'
    },
    keywords: {
      en: [
        'Ceph',
        'storage',
        'capacity',
        'capacity planning',
        'replication',
        'erasure coding',
        'EC',
        'OSD',
        'raw capacity',
        'usable capacity',
        'reserve'
      ],
      zh: [
        'Ceph',
        '存储',
        '容量',
        '容量规划',
        'replication',
        'replication size',
        'erasure coding',
        'EC',
        'OSD',
        'raw capacity',
        'usable capacity',
        'reserve'
      ]
    }
  },
  {
    id: 'kubernetes-resource-calculator',
    category: 'Calculator',
    status: 'available',
    featured: true,
    title: {
      en: 'Kubernetes Resource Calculator',
      zh: 'Kubernetes Resource Calculator'
    },
    description: {
      en: 'Plan CPU and memory requests, limits, node capacity, and Pod density for a homogeneous Kubernetes node pool.',
      zh: '估算 Kubernetes 工作负载的 CPU / Memory requests 与 limits，并评估节点容量和 Pod 密度。'
    },
    path: {
      en: '/tools/kubernetes-resource-calculator/',
      zh: '/zh/tools/kubernetes-resource-calculator/'
    },
    keywords: {
      en: [
        'Kubernetes',
        'resource',
        'resources',
        'k8s',
        'CPU',
        'memory',
        'requests',
        'limits',
        'Pod',
        'node',
        'capacity',
        'scheduling',
        'workload'
      ],
      zh: [
        'Kubernetes',
        '资源',
        'resource',
        'CPU',
        'memory',
        'requests',
        'limits',
        'Pod',
        '节点',
        '容量',
        '调度',
        '工作负载'
      ]
    }
  },
  {
    id: 'kubernetes-quantity-converter',
    category: 'Converter',
    status: 'planned',
    featured: false,
    title: {
      en: 'Kubernetes Quantity Converter',
      zh: 'Kubernetes Quantity Converter'
    },
    description: {
      en: 'Convert Kubernetes resource quantities into readable values and units.',
      zh: '在 mCPU、CPU cores、MiB、GiB 等常用 Kubernetes 资源单位之间快速换算。'
    },
    path: {
      en: null,
      zh: null
    },
    keywords: {
      en: [
        'Kubernetes',
        'quantity',
        'resource quantity',
        'resources',
        'k8s',
        'mCPU',
        'MiB',
        'GiB',
        'CPU',
        'memory',
        'converter',
        'units'
      ],
      zh: [
        'Kubernetes',
        '资源数量',
        'resource quantity',
        '转换',
        '单位',
        'mCPU',
        'MiB',
        'GiB',
        'CPU',
        'memory',
        'converter'
      ]
    }
  }
] as const satisfies readonly Tool[];
