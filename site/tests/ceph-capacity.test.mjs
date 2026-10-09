import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEPH_DEFAULTS,
  CEPH_UNITS,
  calculateCephCapacity,
  validateCephCapacityInputs,
  formatCephCapacity,
  formatCephNumber,
  secondaryCephUnit
} from '../src/lib/cephCapacity.mjs';

const near = (actual, expected, tolerance = 1e-11) => {
  assert.ok(
    Math.abs(actual - expected) <= Math.max(Math.abs(expected) * tolerance, 1e-12),
    'expected ' + actual + ' to be close to ' + expected
  );
};

const run = (patch = {}) => calculateCephCapacity({ ...CEPH_DEFAULTS, ...patch });

test('replicated size=3 baseline: 6 x 4 TB, 15% reserve', () => {
  const result = run();
  assert.equal(result.ok, true);
  assert.equal(result.rawBytes, 24e12);
  near(result.theoreticalBytes, 8e12);
  near(result.planningBytes, 6.8e12);
  near(result.overheadBytes, 16e12);
  near(result.efficiency, 1 / 3);
  near(result.amplification, 3);
  assert.equal(result.placementCheck, 'not-checked');
});

test('EC 4+2 baseline: 24 TB raw, 16 TB theoretical, 13.6 TB planning', () => {
  const result = run({ mode: 'ec' });
  assert.equal(result.ok, true);
  near(result.rawBytes, 24e12);
  near(result.theoreticalBytes, 16e12);
  near(result.planningBytes, 13.6e12);
  near(result.overheadBytes, 8e12);
  near(result.efficiency, 4 / 6);
  near(result.amplification, 1.5);
});

test('different EC ratios match (k+m)/k space amplification', () => {
  for (const [k, m] of [[2, 1], [2, 2], [3, 2], [4, 2], [8, 3]]) {
    const result = run({ mode: 'ec', osdCount: 12, k, m });
    assert.equal(result.ok, true);
    near(result.amplification, (k + m) / k);
    near(result.theoreticalBytes, result.rawBytes * k / (k + m));
    near(result.overheadBytes + result.theoreticalBytes, result.rawBytes);
  }
});

test('replication size 1 yields 100% theoretical efficiency, not safety', () => {
  const result = run({ replication: 1 });
  assert.equal(result.ok, true);
  near(result.efficiency, 1);
  near(result.theoreticalBytes, result.rawBytes);
  near(result.overheadBytes, 0);
});

test('reserve 0% changes no theoretical capacity; high reserve remains bounded', () => {
  const zero = run({ reserve: 0 });
  const high = run({ reserve: 99.99 });
  assert.equal(zero.ok, true);
  assert.equal(high.ok, true);
  near(zero.planningBytes, zero.theoreticalBytes);
  near(high.planningBytes, high.theoreticalBytes * 0.0001);
  assert.ok(high.planningBytes < zero.planningBytes);
});

test('unit conversions use decimal and binary definitions, never 1000=1024', () => {
  assert.equal(CEPH_UNITS.GB, 1e9);
  assert.equal(CEPH_UNITS.TB, 1e12);
  assert.equal(CEPH_UNITS.GiB, 2 ** 30);
  assert.equal(CEPH_UNITS.TiB, 2 ** 40);
  assert.equal(secondaryCephUnit('TB'), 'TiB');
  assert.equal(secondaryCephUnit('GiB'), 'GB');
  assert.equal(secondaryCephUnit('bad'), null);
  assert.equal(formatCephCapacity(1e12, 'TiB'), '0.91 TiB');
  assert.equal(formatCephCapacity(2 ** 30, 'GB'), '1.07 GB');
  assert.equal(formatCephCapacity(24e12, 'TB'), '24 TB');
  assert.equal(formatCephCapacity(24e12, 'unknown'), '—');

  const inTB = run({ capacity: 1, unit: 'TB' });
  const inTiB = run({ capacity: 1e12 / (2 ** 40), unit: 'TiB' });
  assert.equal(inTB.ok, true);
  assert.equal(inTiB.ok, true);
  near(inTB.rawBytes, inTiB.rawBytes);
});

test('formatters preserve small nonzero values instead of showing zero', () => {
  assert.equal(formatCephCapacity(1e9, 'TB'), '<0.01 TB');
  assert.equal(formatCephNumber(0), '0');
  assert.equal(formatCephNumber(1 / 3 * 100), '33.33');
  assert.equal(formatCephCapacity(-1, 'GB'), '—');
});

test('blank inputs never silently become 0 (including optional reserve)', () => {
  for (const field of ['osdCount', 'capacity', 'reserve', 'replication']) {
    const result = run({ [field]: '' });
    assert.equal(result.ok, false, field);
    assert.equal(result.field, field);
    assert.equal(result.code, 'required');
  }
  const kBlank = run({ mode: 'ec', k: '' });
  const mBlank = run({ mode: 'ec', m: '' });
  assert.equal(kBlank.field, 'k');
  assert.equal(mBlank.field, 'm');
});

test('bad number grammar and non-finite input is rejected, not coerced', () => {
  for (const invalid of ['NaN', 'Infinity', '0x10', '1,000', '1 2', '1e309', null, {}, true]) {
    const result = run({ capacity: invalid });
    assert.equal(result.ok, false, String(invalid));
    assert.equal(result.field, 'capacity');
  }
  for (const invalid of [-1, '0', '-0.01']) {
    assert.equal(run({ capacity: invalid }).field, 'capacity');
  }
});

test('OSDs, replication, k, m, hostCount must be safe positive integers', () => {
  for (const raw of [0, -1, 1.5, '1.1', 'abc', Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(run({ osdCount: raw }).field, 'osdCount');
    assert.equal(run({ replication: raw }).ok, false);
    assert.equal(run({ mode: 'ec', k: raw }).field, 'k');
    assert.equal(run({ mode: 'ec', m: raw }).field, 'm');
  }
});

test('counts cannot exceed OSD count even if mathematics would yield a value', () => {
  const repl = run({ replication: 7, osdCount: 6 });
  const ec = run({ mode: 'ec', k: 4, m: 2, osdCount: 5 });
  assert.deepEqual({ field: repl.field, code: repl.code }, { field: 'replication', code: 'exceedsOSDs' });
  assert.deepEqual({ field: ec.field, code: ec.code }, { field: 'm', code: 'exceedsOSDs' });
});

test('reserve must be between 0 and 100, excluding 100', () => {
  for (const raw of [-1, 100, 101, '100']) {
    assert.equal(run({ reserve: raw }).code, 'reserveRange');
  }
  assert.equal(run({ reserve: 15.5 }).ok, true);
});

test('unknown mode, units, or failure domain are rejected', () => {
  assert.equal(run({ mode: 'other' }).field, 'mode');
  assert.equal(run({ unit: '__proto__' }).field, 'unit');
  assert.equal(run({ unit: 'tb' }).field, 'unit');
  assert.equal(run({ failureDomain: 'rack' }).field, 'failureDomain');
});

test('basic host-count check blocks 3 replicas over 2 hosts', () => {
  const invalid = run({ failureDomain: 'host', hostCount: 2 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.field, 'hostCount');
  assert.equal(invalid.code, 'insufficientHosts');

  const minimal = run({ failureDomain: 'host', hostCount: 3 });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.placementCheck, 'counts-only');
});

test('EC 4+2 with host failure domain needs at least 6 hosts for basic check', () => {
  const impossible = run({ mode: 'ec', failureDomain: 'host', hostCount: 4 });
  assert.equal(impossible.field, 'hostCount');
  assert.equal(impossible.code, 'insufficientHosts');

  const possibleCount = run({ mode: 'ec', failureDomain: 'host', hostCount: 6 });
  assert.equal(possibleCount.ok, true);
  assert.equal(possibleCount.placementCheck, 'counts-only');
});

test('host count is required only when host domain is selected', () => {
  assert.equal(run({ failureDomain: 'host', hostCount: '' }).field, 'hostCount');
  assert.equal(run({ failureDomain: 'host', hostCount: 7 }).code, 'hostsExceedOSDs');
  assert.equal(run({ failureDomain: 'osd', hostCount: '' }).ok, true);
  assert.equal(run({ failureDomain: 'unknown', hostCount: '' }).placementCheck, 'not-checked');
});

test('non-finite total capacity is rejected rather than shown as Infinity', () => {
  const result = run({ capacity: 1e305 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'outOfRange');
});

test('mathematical invariants across replicated and EC configurations', () => {
  for (const unit of Object.keys(CEPH_UNITS)) {
    for (const osdCount of [3, 6, 12, 21]) {
      for (const mode of ['replicated', 'ec']) {
        const result = run({
          unit,
          osdCount,
          mode,
          replication: 3,
          k: 2,
          m: 1,
          reserve: 12.5
        });
        assert.equal(result.ok, true);
        assert.ok(result.planningBytes > 0);
        assert.ok(result.planningBytes < result.theoreticalBytes);
        assert.ok(result.theoreticalBytes <= result.rawBytes);
        near(result.overheadBytes + result.theoreticalBytes, result.rawBytes);
        near(result.planningBytes / result.theoreticalBytes, 0.875);
      }
    }
  }
});

test('validate and calculate return consistent normalized numeric inputs', () => {
  const input = { ...CEPH_DEFAULTS, osdCount: '6', reserve: '15', capacity: '4.0' };
  const checked = validateCephCapacityInputs(input);
  const calculated = calculateCephCapacity(input);
  assert.equal(checked.ok, true);
  assert.equal(calculated.ok, true);
  assert.equal(typeof calculated.values.osdCount, 'number');
  assert.equal(calculated.values.reserve, 15);
  assert.equal(calculated.values.capacity, 4);
});
