import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCpuQuantity,
  analyzeMemoryQuantity,
  formatQuantityValue,
  parseQuantity
} from '../src/lib/kubernetesQuantity.js';

const value = (result, key) => formatQuantityValue(result[key]);

test('CPU quantities convert exactly to cores and mCPU', () => {
  const cases = [
    ['500m', '0.5', '500', '500m'],
    ['0.5', '0.5', '500', '500m'],
    ['1', '1', '1000', '1'],
    ['1.5', '1.5', '1500', '1500m'],
    ['1500m', '1.5', '1500', '1500m'],
    ['0', '0', '0', '0'],
    ['1e-3', '0.001', '1', '1m']
  ];

  for (const [input, cores, milliCpu, recommendation] of cases) {
    const result = analyzeCpuQuantity(input);
    assert.equal(result.status, 'Valid', input);
    assert.equal(value(result, 'cpuCores'), cores, input);
    assert.equal(value(result, 'milliCpu'), milliCpu, input);
    assert.equal(result.recommendedQuantity, recommendation, input);
    assert.equal(result.safeForYaml, true, input);
  }
});

test('CPU rejects negative and finer-than-1m resource values', () => {
  for (const input of ['0.5m', '0.0005', '0.1m']) {
    const result = analyzeCpuQuantity(input);
    assert.equal(result.status, 'Error', input);
    assert.equal(result.error, 'cpu-precision', input);
    assert.equal(result.safeForYaml, false, input);
    assert.equal(result.recommendedQuantity, undefined, input);
  }

  const negative = analyzeCpuQuantity('-100m');
  assert.equal(negative.status, 'Error');
  assert.equal(negative.error, 'negative');

  const invalid = analyzeCpuQuantity('abc');
  assert.equal(invalid.status, 'Error');
  assert.equal(invalid.error, 'invalid-number');
});

test('quantity number grammar accepts signs, leading decimals, and trailing decimal points', () => {
  assert.equal(formatQuantityValue(parseQuantity('+1').value), '1');
  assert.equal(formatQuantityValue(parseQuantity('.5').value), '0.5');
  assert.equal(formatQuantityValue(parseQuantity('1.').value), '1');
  assert.equal(formatQuantityValue(parseQuantity('-1').value), '-1');
});

test('decimal and binary suffixes retain their exact meanings', () => {
  const memory = analyzeMemoryQuantity('512Mi');
  assert.equal(memory.status, 'Valid');
  assert.equal(memory.exactBytes, '536,870,912');
  assert.equal(memory.mebibytes.text, '512');

  const gibibyte = analyzeMemoryQuantity('1Gi');
  assert.equal(gibibyte.exactBytes, '1,073,741,824');
  assert.equal(gibibyte.mebibytes.text, '1024');
  assert.equal(gibibyte.gibibytes.text, '1');

  const fractionalGibibyte = analyzeMemoryQuantity('1.5Gi');
  assert.equal(fractionalGibibyte.exactBytes, '1,610,612,736');
  assert.equal(fractionalGibibyte.recommendedQuantity, '1536Mi');

  const mebibytes = analyzeMemoryQuantity('1536Mi');
  assert.equal(mebibytes.recommendedQuantity, '1536Mi');
  assert.equal(analyzeMemoryQuantity('1024Mi').recommendedQuantity, '1Gi');

  const decimalGigabyte = analyzeMemoryQuantity('1G');
  assert.equal(decimalGigabyte.exactBytes, '1,000,000,000');
  assert.equal(decimalGigabyte.megabytes.text, '1000');
  assert.equal(decimalGigabyte.gigabytes.text, '1');
  assert.equal(decimalGigabyte.mebibytes.text, '953.674316');
  assert.equal(decimalGigabyte.mebibytes.approximate, true);
  assert.equal(decimalGigabyte.gibibytes.text, '0.931323');
  assert.equal(decimalGigabyte.gibibytes.approximate, true);
  assert.equal(decimalGigabyte.recommendedQuantity, '1G');

  assert.equal(analyzeMemoryQuantity('1000M').recommendedQuantity, '1G');
  assert.equal(analyzeMemoryQuantity('400M').exactBytes, '400,000,000');
  assert.equal(analyzeMemoryQuantity('400M').recommendedQuantity, '400M');
});

test('decimal exponent and documented near-equivalent quantities parse correctly', () => {
  const expectedBytes = '128,974,848';
  const quantities = ['128974848', '128974848000m', '123Mi'];

  for (const input of quantities) {
    assert.equal(analyzeMemoryQuantity(input).exactBytes, expectedBytes, input);
  }

  assert.equal(analyzeMemoryQuantity('129M').exactBytes, '129,000,000');
  assert.equal(analyzeMemoryQuantity('129e6').exactBytes, '129,000,000');
  assert.equal(analyzeMemoryQuantity('129M').exactBytes === expectedBytes, false);
  assert.equal(formatQuantityValue(parseQuantity('1E3').value), '1000');
  assert.equal(formatQuantityValue(parseQuantity('1E').value), '1000000000000000000');
});

test('fractional bytes and the 400m Memory trap produce warnings, not safe YAML', () => {
  const suspicious = analyzeMemoryQuantity('400m');
  assert.equal(suspicious.status, 'Warning');
  assert.equal(suspicious.exactBytes, '0.4');
  assert.equal(suspicious.warnings.includes('suspicious-millicpu-memory'), true);
  assert.equal(suspicious.warnings.includes('fractional-byte'), true);
  assert.equal(suspicious.safeForYaml, false);
  assert.equal(suspicious.recommendedQuantity, null);

  const fractional = analyzeMemoryQuantity('0.4');
  assert.equal(fractional.status, 'Warning');
  assert.equal(fractional.exactBytes, '0.4');
  assert.equal(fractional.safeForYaml, false);
});

test('precision normalization uses exact rational arithmetic and is reported', () => {
  const parsed = parseQuantity('0.0001');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.precisionNormalized, true);
  assert.equal(formatQuantityValue(parsed.value), '0.0001');
  assert.equal(formatQuantityValue(parsed.normalizedValue), '0.001');

  const memory = analyzeMemoryQuantity('0.0001');
  assert.equal(memory.status, 'Warning');
  assert.equal(memory.precisionNormalized, true);
  assert.equal(memory.warnings.includes('precision-normalized'), true);
  assert.equal(memory.safeForYaml, false);

  const exact = analyzeMemoryQuantity('1.001');
  assert.equal(exact.precisionNormalized, false);
  assert.equal(exact.status, 'Warning');
  assert.equal(exact.warnings.includes('fractional-byte'), true);
  assert.equal(exact.safeForYaml, false);
});

test('invalid aliases, suffix casing, whitespace, and special numbers are rejected', () => {
  const lowercaseBinary = analyzeMemoryQuantity('512mi');
  assert.equal(lowercaseBinary.status, 'Error');
  assert.equal(lowercaseBinary.error, 'suffix-case');

  const byteAlias = analyzeMemoryQuantity('512MB');
  assert.equal(byteAlias.status, 'Error');
  assert.equal(byteAlias.error, 'decimal-memory-suffix');

  for (const input of ['NaN', 'Infinity', '1 2', '512XB', '']) {
    assert.equal(parseQuantity(input).ok, false, input);
  }

  assert.equal(parseQuantity('  500m  ').ok, true);
  assert.equal(parseQuantity('1M').ok, true);
  assert.equal(parseQuantity('1m').ok, true);
});

test('negative resources and magnitudes above 2^63 - 1 are errors', () => {
  assert.equal(analyzeMemoryQuantity('-1').error, 'negative');
  assert.equal(analyzeCpuQuantity('-1').error, 'negative');
  assert.equal(parseQuantity('9223372036854775807').ok, true);
  assert.equal(parseQuantity('9223372036854775808').code, 'out-of-range');
  assert.equal(parseQuantity('8Ei').code, 'out-of-range');
  assert.equal(parseQuantity('1e1001').code, 'out-of-range');
  assert.equal(parseQuantity('1e-1001').code, 'out-of-range');
});

test('supported but unusual CPU suffixes are warned and cannot be copied as safe YAML', () => {
  const result = analyzeCpuQuantity('1Ki');
  assert.equal(result.status, 'Warning');
  assert.equal(result.warnings.includes('unusual-cpu-suffix'), true);
  assert.equal(result.safeForYaml, false);
  assert.equal(result.recommendedQuantity, '1024');
});
