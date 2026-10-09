/**
 * Theoretical Ceph capacity planner. Not a simulator of CRUSH or ceph df MAX AVAIL.
 *
 * Assumptions: identical OSD capacities, all selected OSDs usable for the
 * specified pool, no utilization/BlueStore/metadata/allocation overhead,
 * no topology imbalance, and the standard (k+m)/k EC amplification.
 *
 * Ceph references:
 * https://docs.ceph.com/en/squid/rados/operations/erasure-code/
 * https://docs.ceph.com/en/squid/rados/operations/monitoring/
 * https://docs.ceph.com/en/squid/rados/operations/crush-map/
 */
export const CEPH_UNITS = Object.freeze({
  GB: 10 ** 9,
  GiB: 2 ** 30,
  TB: 10 ** 12,
  TiB: 2 ** 40
});

export const CEPH_DEFAULTS = Object.freeze({
  mode: 'replicated',
  osdCount: 6,
  capacity: 4,
  unit: 'TB',
  replication: 3,
  k: 4,
  m: 2,
  reserve: 15,
  failureDomain: 'unknown',
  hostCount: ''
});

const SECONDARY_UNIT = Object.freeze({
  GB: 'GiB',
  GiB: 'GB',
  TB: 'TiB',
  TiB: 'TB'
});

const error = (field, code) => ({ ok: false, field, code });

/** Accept HTML number input strings and numeric test inputs; never treat blank as zero. */
function parseDecimal(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : { code: 'invalid' };
  if (typeof raw !== 'string') return { code: 'invalid' };

  const text = raw.trim();
  if (!text) return { code: 'required' };
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) {
    return { code: 'invalid' };
  }

  const value = Number(text);
  return Number.isFinite(value) ? { value } : { code: 'invalid' };
}

function positiveInteger(field, raw) {
  const parsed = parseDecimal(raw);
  if (parsed.code) return error(field, parsed.code);
  if (!Number.isSafeInteger(parsed.value) || parsed.value < 1) {
    return error(field, 'positiveInteger');
  }
  return { ok: true, value: parsed.value };
}

function finiteCapacity(field, raw) {
  const parsed = parseDecimal(raw);
  if (parsed.code) return error(field, parsed.code);
  return parsed.value > 0
    ? { ok: true, value: parsed.value }
    : error(field, 'positive');
}

/**
 * A successful count check means only that the number of hosts/OSDs is not
 * obviously insufficient. It never proves actual CRUSH placement feasibility.
 */
export function validateCephCapacityInputs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return error('mode', 'invalid');
  }

  if (!['replicated', 'ec'].includes(input.mode)) return error('mode', 'invalid');

  const osds = positiveInteger('osdCount', input.osdCount);
  if (!osds.ok) return osds;

  const capacity = finiteCapacity('capacity', input.capacity);
  if (!capacity.ok) return capacity;

  if (!Object.hasOwn(CEPH_UNITS, input.unit)) return error('unit', 'invalid');

  const reserve = parseDecimal(input.reserve);
  if (reserve.code) return error('reserve', reserve.code);
  if (reserve.value < 0 || reserve.value >= 100) return error('reserve', 'reserveRange');

  const values = {
    mode: input.mode,
    osdCount: osds.value,
    capacity: capacity.value,
    unit: input.unit,
    reserve: reserve.value,
    failureDomain: input.failureDomain ?? 'unknown'
  };

  let requiredChunks;
  if (input.mode === 'replicated') {
    const replication = positiveInteger('replication', input.replication);
    if (!replication.ok) return replication;
    values.replication = replication.value;
    requiredChunks = replication.value;
    if (requiredChunks > values.osdCount) return error('replication', 'exceedsOSDs');
  } else {
    const k = positiveInteger('k', input.k);
    if (!k.ok) return k;
    const m = positiveInteger('m', input.m);
    if (!m.ok) return m;
    values.k = k.value;
    values.m = m.value;
    requiredChunks = k.value + m.value;
    if (requiredChunks > values.osdCount) return error('m', 'exceedsOSDs');
  }

  if (!['unknown', 'host', 'osd'].includes(values.failureDomain)) {
    return error('failureDomain', 'invalid');
  }

  if (values.failureDomain === 'host') {
    const hosts = positiveInteger('hostCount', input.hostCount);
    if (!hosts.ok) return hosts;
    values.hostCount = hosts.value;
    if (hosts.value > values.osdCount) return error('hostCount', 'hostsExceedOSDs');
    if (hosts.value < requiredChunks) return error('hostCount', 'insufficientHosts');
  }

  return {
    ok: true,
    values,
    requiredChunks,
    placementCheck: values.failureDomain === 'unknown'
      ? 'not-checked'
      : 'counts-only'
  };
}

export function calculateCephCapacity(input) {
  const checked = validateCephCapacityInputs(input);
  if (!checked.ok) return checked;

  const values = checked.values;
  const rawBytes = values.osdCount * values.capacity * CEPH_UNITS[values.unit];
  const efficiency = values.mode === 'replicated'
    ? 1 / values.replication
    : values.k / (values.k + values.m);
  const theoreticalBytes = rawBytes * efficiency;
  const planningBytes = theoreticalBytes * (1 - values.reserve / 100);
  const overheadBytes = rawBytes - theoreticalBytes;

  if (![rawBytes, efficiency, theoreticalBytes, planningBytes, overheadBytes]
    .every(Number.isFinite) || rawBytes <= 0 || theoreticalBytes <= 0 || planningBytes <= 0) {
    return error('capacity', 'outOfRange');
  }

  return {
    ...checked,
    rawBytes,
    theoreticalBytes,
    planningBytes,
    overheadBytes,
    efficiency,
    amplification: 1 / efficiency
  };
}

export function secondaryCephUnit(unit) {
  return Object.hasOwn(SECONDARY_UNIT, unit) ? SECONDARY_UNIT[unit] : null;
}

export function formatCephNumber(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value > 0 && value < 0.005) return '<0.01';
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function formatCephCapacity(bytes, unit) {
  if (!Number.isFinite(bytes) || bytes < 0 || !Object.hasOwn(CEPH_UNITS, unit)) return '—';
  return formatCephNumber(bytes / CEPH_UNITS[unit]) + ' ' + unit;
}
