const MAX_MAGNITUDE = (1n << 63n) - 1n;
const MAX_INPUT_LENGTH = 256;
const MAX_EXPONENT = 1000n;
const PRECISION_SCALE = 1000n;

const decimalSuffixes = new Map([
  ['', [1n, 1n]],
  ['m', [1n, 1000n]],
  ['k', [1000n, 1n]],
  ['M', [1000000n, 1n]],
  ['G', [1000000000n, 1n]],
  ['T', [1000000000000n, 1n]],
  ['P', [1000000000000000n, 1n]],
  ['E', [1000000000000000000n, 1n]],
  ['Ki', [1024n, 1n]],
  ['Mi', [1048576n, 1n]],
  ['Gi', [1073741824n, 1n]],
  ['Ti', [1099511627776n, 1n]],
  ['Pi', [1125899906842624n, 1n]],
  ['Ei', [1152921504606846976n, 1n]]
]);

const binaryMemoryUnits = [
  ['Ei', 1n << 60n],
  ['Pi', 1n << 50n],
  ['Ti', 1n << 40n],
  ['Gi', 1n << 30n],
  ['Mi', 1n << 20n],
  ['Ki', 1n << 10n]
];

const decimalMemoryUnits = [
  ['E', 1000000000000000000n],
  ['P', 1000000000000000n],
  ['T', 1000000000000n],
  ['G', 1000000000n],
  ['M', 1000000n],
  ['k', 1000n]
];

const abs = (value) => value < 0n ? -value : value;

const gcd = (left, right) => {
  let a = abs(left);
  let b = abs(right);

  while (b !== 0n) {
    [a, b] = [b, a % b];
  }

  return a || 1n;
};

const rational = (numerator, denominator = 1n) => {
  if (denominator === 0n) throw new RangeError('A rational denominator cannot be zero.');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);

  return {
    numerator: numerator / divisor * sign,
    denominator: abs(denominator) / divisor
  };
};

const multiply = (left, right) =>
  rational(left.numerator * right.numerator, left.denominator * right.denominator);

const divide = (left, right) =>
  rational(left.numerator * right.denominator, left.denominator * right.numerator);

const compare = (left, right) => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

const compareMagnitude = (value, limit) => {
  const left = abs(value.numerator);
  const right = limit * value.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
};

const ceilDivide = (numerator, denominator) =>
  numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;

const normalizePrecision = (value) => {
  const scaledNumerator = abs(value.numerator) * PRECISION_SCALE;
  if (scaledNumerator % value.denominator === 0n) {
    return { value, normalized: false };
  }

  const rounded = ceilDivide(scaledNumerator, value.denominator);
  const signed = value.numerator < 0n ? -rounded : rounded;

  return {
    value: rational(signed, PRECISION_SCALE),
    normalized: true
  };
};

const errorResult = (code, details = {}) => ({ ok: false, code, ...details });

const caseInsensitiveSuffix = (suffix) => {
  const lowered = suffix.toLowerCase();
  for (const known of decimalSuffixes.keys()) {
    if (known && known.toLowerCase() === lowered) return known;
  }
  return null;
};

const parseExponent = (suffix) => {
  const match = suffix.match(/^[eE]([+-]?\d+)$/);
  if (!match) return null;

  let exponent;
  try {
    exponent = BigInt(match[1]);
  } catch {
    return { error: 'invalid-exponent' };
  }

  if (abs(exponent) > MAX_EXPONENT) return { error: 'out-of-range' };

  return { exponent };
};

/**
 * Parse a Kubernetes Quantity into an exact rational base-unit value.
 * Values beyond Kubernetes' documented magnitude or this parser's bounded
 * exponent/input budget are rejected rather than truncated or capped.
 */
export function parseQuantity(input) {
  const source = String(input ?? '').trim();
  if (!source) return errorResult('empty');
  if (source.length > MAX_INPUT_LENGTH) return errorResult('out-of-range');

  const match = source.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(.*)$/);
  if (!match) return errorResult('invalid-number');

  const [, sign, integerPart = '', decimalPart = '', leadingDecimalPart = '', suffix] = match;
  const fraction = integerPart === '' ? leadingDecimalPart : decimalPart;
  const digits = `${integerPart || '0'}${fraction}`;
  let numerator;

  try {
    numerator = BigInt(digits || '0');
  } catch {
    return errorResult('invalid-number');
  }

  if (sign === '-') numerator = -numerator;
  let value = rational(numerator, 10n ** BigInt(fraction.length));
  let notation = 'decimal';
  let suffixMultiplier;

  if (suffix === '') {
    suffixMultiplier = rational(1n);
  } else {
    const exponent = parseExponent(suffix);

    if (exponent?.error) return errorResult(exponent.error);
    if (exponent) {
      notation = 'exponent';
      const power = abs(exponent.exponent);
      const factor = 10n ** power;
      suffixMultiplier = exponent.exponent < 0n
        ? rational(1n, factor)
        : rational(factor);
    } else if (decimalSuffixes.has(suffix)) {
      const [unitNumerator, unitDenominator] = decimalSuffixes.get(suffix);
      suffixMultiplier = rational(unitNumerator, unitDenominator);
    } else {
      const expectedSuffix = caseInsensitiveSuffix(suffix);
      return errorResult(expectedSuffix ? 'suffix-case' : 'unsupported-suffix', {
        suffix,
        expectedSuffix
      });
    }
  }

  value = multiply(value, suffixMultiplier);

  if (compareMagnitude(value, MAX_MAGNITUDE) > 0) {
    return errorResult('out-of-range');
  }

  const precision = normalizePrecision(value);
  if (compareMagnitude(precision.value, MAX_MAGNITUDE) > 0) {
    return errorResult('out-of-range');
  }

  return {
    ok: true,
    source,
    suffix,
    notation,
    value,
    normalizedValue: precision.value,
    precisionNormalized: precision.normalized
  };
}

const formatExactRational = (value) => {
  let remaining = value.denominator;
  let twos = 0;
  let fives = 0;

  while (remaining % 2n === 0n) {
    remaining /= 2n;
    twos += 1;
  }
  while (remaining % 5n === 0n) {
    remaining /= 5n;
    fives += 1;
  }

  if (remaining !== 1n) throw new RangeError('The rational cannot be represented as a finite decimal.');

  const places = Math.max(twos, fives);
  const scale = 10n ** BigInt(places);
  const scaled = abs(value.numerator) * scale / value.denominator;
  const whole = scaled / scale;
  const fraction = places
    ? (scaled % scale).toString().padStart(places, '0').replace(/0+$/, '')
    : '';
  const sign = value.numerator < 0n ? '-' : '';

  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
};

const formatRoundedRational = (value, places = 6) => {
  const scale = 10n ** BigInt(places);
  const scaledNumerator = abs(value.numerator) * scale;
  const rounded = (scaledNumerator * 2n + value.denominator) / (2n * value.denominator);
  const whole = rounded / scale;
  const fraction = places
    ? (rounded % scale).toString().padStart(places, '0').replace(/0+$/, '')
    : '';
  const sign = value.numerator < 0n ? '-' : '';
  const roundedValue = rational(rounded * (value.numerator < 0n ? -1n : 1n), scale);
  const threshold = `0.${'0'.repeat(Math.max(0, places - 1))}1`;
  const text = rounded === 0n && value.numerator > 0n
    ? `<${threshold}`
    : rounded === 0n && value.numerator < 0n
      ? `>-${threshold}`
      : `${sign}${whole}${fraction ? `.${fraction}` : ''}`;

  return {
    text,
    approximate: compare(value, roundedValue) !== 0
  };
};

const groupThousands = (value) => {
  const [whole, fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
};

const precisionWarning = (parsed) => parsed.precisionNormalized
  ? ['precision-normalized']
  : [];

const failedAnalysis = (parsed) => ({
  status: 'Error',
  ok: false,
  error: parsed.code,
  source: parsed.source || '',
  safeForYaml: false
});

const createAnalysis = (parsed, value, warnings, output) => ({
  status: warnings.length ? 'Warning' : 'Valid',
  ok: true,
  source: parsed.source,
  value,
  precisionNormalized: parsed.precisionNormalized,
  warnings,
  safeForYaml: warnings.length === 0 && Boolean(output.recommendedQuantity),
  ...output
});

const isNegative = (value) => value.numerator < 0n;

const asRational = (numerator, denominator = 1n) => rational(numerator, denominator);

const cpuRecommendation = (milliCpu) => {
  if (milliCpu.denominator !== 1n) return null;
  if (milliCpu.numerator % 1000n === 0n) {
    return (milliCpu.numerator / 1000n).toString();
  }
  return `${milliCpu.numerator}m`;
};

/** Analyze a CPU quantity in cores and milliCPU without floating-point arithmetic. */
export function analyzeCpuQuantity(input) {
  const parsed = parseQuantity(input);
  if (!parsed.ok) return failedAnalysis(parsed);

  if (isNegative(parsed.value)) {
    return { ...failedAnalysis(parsed), error: 'negative' };
  }

  if (
    parsed.value.numerator > 0n &&
    compare(parsed.value, asRational(1n, 1000n)) < 0
  ) {
    return { ...failedAnalysis(parsed), error: 'cpu-precision' };
  }

  const value = parsed.normalizedValue;
  const milliCpu = multiply(value, asRational(1000n));
  const warnings = precisionWarning(parsed);
  if (parsed.notation !== 'exponent' && parsed.suffix && parsed.suffix !== 'm') {
    warnings.push('unusual-cpu-suffix');
  }

  return createAnalysis(parsed, value, warnings, {
    cpuCores: value,
    milliCpu,
    recommendedQuantity: cpuRecommendation(milliCpu)
  });
}

const memoryRecommendation = (bytes) => {
  if (bytes.denominator !== 1n) return null;
  if (bytes.numerator === 0n) return '0';

  const candidates = [bytes.numerator.toString()];
  for (const [suffix, factor] of [...binaryMemoryUnits, ...decimalMemoryUnits]) {
    if (bytes.numerator % factor === 0n) {
      candidates.push(`${bytes.numerator / factor}${suffix}`);
    }
  }

  return candidates.reduce((best, candidate) =>
    candidate.length < best.length ? candidate : best
  );
};

/** Analyze a Memory quantity as exact bytes and display-unit ratios. */
export function analyzeMemoryQuantity(input) {
  const parsed = parseQuantity(input);
  if (!parsed.ok) {
    const analysis = failedAnalysis(parsed);
    if (parsed.code === 'unsupported-suffix' && parsed.suffix === 'MB') {
      analysis.error = 'decimal-memory-suffix';
    }
    return analysis;
  }

  if (isNegative(parsed.value)) {
    return { ...failedAnalysis(parsed), error: 'negative' };
  }

  const bytes = parsed.normalizedValue;
  const warnings = precisionWarning(parsed);
  if (bytes.denominator !== 1n) warnings.push('fractional-byte');
  if (
    parsed.suffix === 'm' &&
    parsed.value.numerator === 2n &&
    parsed.value.denominator === 5n
  ) {
    warnings.push('suspicious-millicpu-memory');
  }

  const displayValue = (divisor) => formatRoundedRational(divide(bytes, asRational(divisor)), 6);

  return createAnalysis(parsed, bytes, warnings, {
    bytes,
    exactBytes: groupThousands(formatExactRational(bytes)),
    mebibytes: displayValue(1n << 20n),
    gibibytes: displayValue(1n << 30n),
    megabytes: displayValue(1000000n),
    gigabytes: displayValue(1000000000n),
    recommendedQuantity: memoryRecommendation(bytes)
  });
}

export function formatQuantityValue(value) {
  return formatExactRational(value);
}

export function formatQuantityApproximation(value, places = 6) {
  return formatRoundedRational(value, places);
}
