import { expect, test } from '@playwright/test';

const productionOrigin = 'https://infra.oeax.de';

const extractLocations = (xml) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => match[1]);

const productionUrl = (path) =>
  new URL(path, productionOrigin).toString();

const localizedPair = (path) => {
  if (path === '/zh/') {
    return { en: '/', zh: '/zh/' };
  }

  if (path.startsWith('/zh/')) {
    return {
      en: path.replace(/^\/zh/, ''),
      zh: path
    };
  }

  return {
    en: path,
    zh: path === '/' ? '/zh/' : `/zh${path}`
  };
};

const sitemapPaths = async (request) => {
  const indexResponse = await request.get('/sitemap-index.xml');
  expect(indexResponse.ok()).toBeTruthy();

  const sitemapUrls = extractLocations(await indexResponse.text());
  expect(sitemapUrls.length).toBeGreaterThan(0);

  const paths = [];

  for (const sitemapUrl of sitemapUrls) {
    const parsed = new URL(sitemapUrl);
    expect(parsed.origin).toBe(productionOrigin);

    const response = await request.get(parsed.pathname);
    expect(response.ok()).toBeTruthy();

    for (const pageUrl of extractLocations(await response.text())) {
      const page = new URL(pageUrl);
      expect(page.origin).toBe(productionOrigin);
      paths.push(page.pathname);
    }
  }

  return [...new Set(paths)].sort();
};

const expectSeoMetadata = async (page, path, options = {}) => {
  const { noindex = false } = options;
  const { en, zh } = localizedPair(path);

  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response?.ok(), `Failed to load ${path}`).toBeTruthy();

  const title = (await page.title()).trim();
  expect(title, `Missing title on ${path}`).not.toBe('');

  const description = page.locator('meta[name="description"]');
  await expect(
    description,
    `Expected exactly one meta description on ${path}`
  ).toHaveCount(1);
  expect(
    (await description.getAttribute('content'))?.trim(),
    `Missing meta description content on ${path}`
  ).toBeTruthy();

  const canonical = page.locator('link[rel="canonical"]');
  await expect(
    canonical,
    `Expected exactly one canonical on ${path}`
  ).toHaveCount(1);
  await expect(canonical).toHaveAttribute('href', productionUrl(path));

  await expect(page.locator('html')).toHaveAttribute(
    'lang',
    path.startsWith('/zh/') ? 'zh-CN' : 'en'
  );

  const enAlternate = page.locator(
    'link[rel="alternate"][hreflang="en"]'
  );
  const zhAlternate = page.locator(
    'link[rel="alternate"][hreflang="zh-CN"]'
  );
  const defaultAlternate = page.locator(
    'link[rel="alternate"][hreflang="x-default"]'
  );

  await expect(enAlternate).toHaveCount(1);
  await expect(zhAlternate).toHaveCount(1);
  await expect(defaultAlternate).toHaveCount(1);

  await expect(enAlternate).toHaveAttribute('href', productionUrl(en));
  await expect(zhAlternate).toHaveAttribute('href', productionUrl(zh));
  await expect(defaultAlternate).toHaveAttribute('href', productionUrl(en));

  const robots = page.locator('meta[name="robots"]');

  if (noindex) {
    await expect(robots).toHaveCount(1);
    const content = ((await robots.getAttribute('content')) || '').toLowerCase();
    expect(content).toContain('noindex');
    expect(content).toContain('follow');
  } else {
    const contents = await robots.evaluateAll((elements) =>
      elements.map((element) =>
        (element.getAttribute('content') || '').toLowerCase()
      )
    );

    expect(
      contents.some((content) => content.includes('noindex')),
      `Unexpected noindex on ${path}`
    ).toBeFalsy();
  }
};

test.describe('SEO regression', () => {
  test('robots.txt advertises the production sitemap', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.ok()).toBeTruthy();

    const body = await response.text();

    expect(body).toContain('User-agent: *');
    expect(body).toContain('Allow: /');
    expect(body).toContain(
      'Sitemap: https://infra.oeax.de/sitemap-index.xml'
    );
  });

  test('all sitemap pages keep canonical, metadata and reciprocal hreflang', async ({
    page,
    request
  }) => {
    test.setTimeout(90_000);

    const paths = await sitemapPaths(request);
    const pathSet = new Set(paths);

    expect(paths).not.toContain('/search/');
    expect(paths).not.toContain('/zh/search/');

    for (const path of paths) {
      const { en, zh } = localizedPair(path);

      expect(
        pathSet.has(en),
        `Missing English counterpart ${en} for ${path}`
      ).toBeTruthy();
      expect(
        pathSet.has(zh),
        `Missing Chinese counterpart ${zh} for ${path}`
      ).toBeTruthy();

      await expectSeoMetadata(page, path);
    }
  });

  test('Ceph calculator SEO metadata describes theoretical and planning capacity', async ({ page }) => {
    const pages = [
      {
        path: '/tools/ceph-capacity-calculator/',
        title: 'Ceph Storage Capacity Calculator (EC & Replication) | InfraOpsX',
        description: 'Estimate Ceph raw and theoretical usable storage for replication and erasure coding (EC), plus efficiency, overhead, and reserve-based planning capacity—not MAX AVAIL.'
      },
      {
        path: '/zh/tools/ceph-capacity-calculator/',
        title: 'Ceph 存储容量计算器（副本与 EC 纠删码）| InfraOpsX',
        description: '估算 Ceph 副本与 EC 纠删码布局的原始容量、理论可用容量、存储效率、冗余开销和按预留比例计算的规划容量；结果不等于实际 MAX AVAIL。'
      }
    ];

    for (const entry of pages) {
      const response = await page.goto(entry.path);
      expect(response?.ok()).toBeTruthy();
      await expect(page).toHaveTitle(entry.title);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', entry.description);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', productionUrl(entry.path));
    }
  });

  test('search pages stay noindex and outside the sitemap', async ({
    page,
    request
  }) => {
    const paths = await sitemapPaths(request);

    expect(paths).not.toContain('/search/');
    expect(paths).not.toContain('/zh/search/');

    for (const path of ['/search/', '/zh/search/']) {
      await expectSeoMetadata(page, path, { noindex: true });
    }
  });
});
