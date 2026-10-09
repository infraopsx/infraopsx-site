/**
 * One-off production acceptance suite.
 * Uses HTTPS infra.oeax.de directly. Never mutates server state.
 * Intended to run from GitHub Actions with network access.
 */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const origin = 'https://infra.oeax.de';
const enPath = '/tools/ceph-capacity-calculator/';
const zhPath = '/zh/tools/ceph-capacity-calculator/';
const results = [];

async function check(label, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    const item = { label, status: 'PASS', ms: Date.now() - startedAt };
    results.push(item);
    console.log('[PASS] ' + label + ' (' + item.ms + 'ms)');
  } catch (error) {
    const item = { label, status: 'FAIL', detail: error.message };
    results.push(item);
    console.error('[FAIL] ' + label + '\n' + (error.stack || error.message));
  }
}

const browser = await chromium.launch({ headless: true });

async function usePage(fn, options = {}) {
  const page = await browser.newPage(options);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  try {
    await fn(page);
    assert.deepEqual(errors, [], 'JavaScript page errors on production');
  } finally {
    await page.close();
  }
}

async function go(page, path) {
  const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 35000 });
  assert.ok(response, 'No HTTP response for ' + path);
  assert.equal(response.status(), 200, 'HTTP response for ' + path);
  assert.equal(new URL(page.url()).hostname, 'infra.oeax.de', 'must test actual production hostname');
}

const seo = [
  {
    path: enPath,
    title: 'Ceph Storage Capacity Calculator (EC & Replication) | InfraOpsX',
    description: 'Estimate Ceph raw and theoretical usable storage for replication and erasure coding (EC), plus efficiency, overhead, and reserve-based planning capacity—not MAX AVAIL.',
    lang: 'en'
  },
  {
    path: zhPath,
    title: 'Ceph 存储容量计算器（副本与 EC 纠删码）| InfraOpsX',
    description: '估算 Ceph 副本与 EC 纠删码布局的原始容量、理论可用容量、存储效率、冗余开销和按预留比例计算的规划容量；结果不等于实际 MAX AVAIL。',
    lang: 'zh-CN'
  }
];

for (const item of seo) {
  await check(item.lang + ' production SEO title, description, canonical, hreflang and HTTP 200', async () => {
    await usePage(async (page) => {
      await go(page, item.path);
      assert.equal(await page.title(), item.title, 'Live <title> does not match main');
      assert.equal(await page.locator('meta[name="description"]').getAttribute('content'),
        item.description, 'Live meta description does not match main');
      await expect(page.locator('link[rel="canonical"]'))
        .toHaveAttribute('href', origin + item.path);
      await expect(page.locator('link[rel="alternate"][hreflang="en"]'))
        .toHaveAttribute('href', origin + enPath);
      await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]'))
        .toHaveAttribute('href', origin + zhPath);
      await expect(page.locator('html')).toHaveAttribute('lang', item.lang);
      const robots = (await page.locator('meta[name="robots"]').all()).map(async el => el.getAttribute('content'));
      const meta = await Promise.all(robots);
      assert.equal(meta.some(s => String(s).includes('noindex')), false, 'Live page is noindex');
      await expect(page.locator('h1')).toBeVisible();
    });
  });
}

await check('production URL redirect uses HTTPS and one redirect', async () => {
  await usePage(async (page) => {
    const r = await page.request.get(origin + '/tools/ceph-capacity-calculator', { maxRedirects: 0, timeout: 25000 });
    assert.ok([301, 308].includes(r.status()), 'Expected 301/308, got ' + r.status());
    assert.equal(r.headers().location, origin + enPath, 'redirect Location must stay on HTTPS');
    const target = await page.request.get(origin + enPath, { timeout: 25000 });
    assert.equal(target.status(), 200);
  });
});

await check('production Replicated 6 x 4 TB baseline', async () => {
  await usePage(async (page) => {
    await go(page, enPath);
    await expect(page.locator('[data-result="raw"]')).toHaveText('24 TB');
    await expect(page.locator('[data-result="theoretical"]')).toHaveText('8 TB');
    await expect(page.locator('[data-result="planning"]')).toHaveText('6.8 TB');
    await expect(page.locator('[data-result="efficiency"]')).toHaveText('33.33%');
    await expect(page.locator('[data-result="overhead"]')).toHaveText('16 TB');
  });
});

await check('production EC 4+2 and edit 9 OSDs', async () => {
  await usePage(async (page) => {
    await go(page, enPath);
    await page.locator('[data-mode-option="ec"]').click();
    await expect(page.locator('[data-result="theoretical"]')).toHaveText('16 TB');
    await expect(page.locator('[data-result="planning"]')).toHaveText('13.6 TB');
    await expect(page.locator('[data-result="overhead"]')).toHaveText('8 TB');
    await expect(page.locator('[data-result="efficiency"]')).toHaveText('66.67%');

    await page.locator('[data-mode-option="replicated"]').click();
    await page.locator('[data-input="osdCount"]').fill('9');
    await expect(page.locator('[data-result="raw"]')).toHaveText('—');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-result="raw"]')).toHaveText('36 TB');
    await expect(page.locator('[data-result="theoretical"]')).toHaveText('12 TB');
    await expect(page.locator('[data-result="planning"]')).toHaveText('10.2 TB');
  });
});

await check('production validation rejects blank reserve and too many replicas', async () => {
  await usePage(async (page) => {
    await go(page, enPath);
    await page.locator('[data-input="reserve"]').fill('');
    await expect(page.locator('[data-result="planning"]')).toHaveText('—');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-calculator-error]')).toContainText('required');
    await expect(page.locator('[data-input="reserve"]')).toHaveAttribute('aria-invalid', 'true');
    await page.locator('[data-input="reserve"]').fill('15');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-result="planning"]')).toHaveText('6.8 TB');
    await page.locator('[data-input="replication"]').fill('7');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-calculator-error]')).toContainText('cannot exceed the OSD count');
    await expect(page.locator('[data-result="planning"]')).toHaveText('—');
  });
});

await check('production optional host check blocks 2 hosts / 3 replicas and EC 4+2 / 4 hosts', async () => {
  await usePage(async (page) => {
    await go(page, enPath);
    await page.locator('[data-topology-details] summary').click();
    await page.locator('[data-input="failureDomain"]').selectOption('host');
    await page.locator('[data-input="hostCount"]').fill('2');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-calculator-error]')).toContainText('Too few hosts');
    await expect(page.locator('[data-result="planning"]')).toHaveText('—');

    await page.locator('[data-input="hostCount"]').fill('3');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-result="planning"]')).toHaveText('6.8 TB');
    await expect(page.locator('[data-placement-status]')).toContainText('not verified');

    await page.locator('[data-mode-option="ec"]').click();
    await page.locator('[data-input="hostCount"]').fill('4');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-calculator-error]')).toContainText('Too few hosts');
    await page.locator('[data-input="hostCount"]').fill('6');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();
    await expect(page.locator('[data-result="theoretical"]')).toHaveText('16 TB');
  });
});

for (const locale of ['en', 'zh']) {
  await check(locale + ' production mobile 390px viewport, calculation and no horizontal overflow', async () => {
    await usePage(async (page) => {
      await go(page, locale === 'en' ? enPath : zhPath);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('[data-result="planning"]')).toHaveText('6.8 TB');
      await page.locator('[data-input="osdCount"]').fill('9');
      await page.getByRole('button', { name: locale === 'en' ? 'Calculate capacity' : '计算容量' }).click();
      await expect(page.locator('[data-result="planning"]')).toHaveText('10.2 TB');
      const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        viewport: window.innerWidth
      }));
      assert.ok(metrics.doc <= metrics.viewport + 1 && metrics.body <= metrics.viewport + 1,
        'horizontal overflow: ' + JSON.stringify(metrics));
    });
  });
}

await browser.close();

const passed = results.filter(x => x.status === 'PASS').length;
const failed = results.length - passed;
console.log('\n=== LIVE PRODUCTION RESULT ===');
console.log('TARGET: ' + origin);
console.log('PASSED: ' + passed + '/' + results.length);
console.log('FAILED: ' + failed);
for (const result of results) console.log(result.status + ' | ' + result.label);
if (failed > 0) process.exitCode = 1;
