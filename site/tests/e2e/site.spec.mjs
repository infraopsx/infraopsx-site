import { expect, test } from '@playwright/test';

const routes = [
  ['/', /Infrastructure that stays/],
  ['/zh/', /让基础设施保持/],
  ['/blog/', 'Real problems. Practical notes.'],
  ['/zh/blog/', '真实问题，实用记录。'],
  ['/tools/', 'Practical infrastructure tools for real-world systems.'],
  ['/zh/tools/', '面向真实基础设施的实用工具。'],
  ['/tools/ceph-capacity-calculator/', 'Ceph Capacity Calculator'],
  ['/tools/kubernetes-resource-calculator/', 'Kubernetes Resource Calculator'],
  ['/tools/kubernetes-quantity-converter/', 'Kubernetes Quantity Converter'],
  ['/blog/rook-ceph-osd-high-memory-osd-memory-target/', /Rook Ceph OSD High Memory Usage/],
  ['/zh/blog/rook-ceph-osd-high-memory-osd-memory-target/', /Rook Ceph OSD 内存占用过高/]
];


const readStructuredData = async (page) => {
  const payloads = await page.locator('script[type="application/ld+json"]').allTextContents();
  return payloads
    .map((payload) => JSON.parse(payload))
    .flatMap((payload) => payload['@graph'] || [payload]);
};

const collectBrowserErrors = (page) => {
  const errors = [];

  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });

  return errors;
};

test.describe('core site', () => {
  for (const [path, heading] of routes) {
    test(`opens ${path}`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      const response = await page.goto(path);

      expect(response?.ok()).toBeTruthy();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }


  test('does not load production analytics on local E2E host', async ({ page }) => {
    const analyticsRequests = [];

    page.on('request', (request) => {
      if (request.url().startsWith('https://analytics.oeax.de/')) {
        analyticsRequests.push(request.url());
      }
    });

    await page.goto('/');

    await expect(
      page.locator('script[src="https://analytics.oeax.de/count.js"]')
    ).toHaveCount(0);
    expect(analyticsRequests).toEqual([]);
  });


  test('homepage exposes Organization and WebSite structured data', async ({ page }) => {
    await page.goto('/');

    const structuredData = await readStructuredData(page);
    const organization = structuredData.find((node) => node['@type'] === 'Organization');
    const website = structuredData.find((node) => node['@type'] === 'WebSite');

    expect(organization).toMatchObject({
      name: 'InfraOpsX',
      url: 'https://infra.oeax.de/'
    });
    expect(website).toMatchObject({
      name: 'InfraOpsX',
      url: 'https://infra.oeax.de/'
    });
    expect(website.publisher).toEqual({
      '@id': 'https://infra.oeax.de/#organization'
    });
  });

  test('articles expose visible and structured author identity', async ({ page }) => {
    await page.goto('/blog/rook-ceph-osd-high-memory-osd-memory-target/');

    const authorLink = page.locator('.article-meta .article-author a');
    await expect(authorLink).toHaveText('InfraOpsX');
    await expect(authorLink).toHaveAttribute('href', '/about/');

    const structuredData = await readStructuredData(page);
    const article = structuredData.find((node) => node['@type'] === 'BlogPosting');

    expect(article.author).toMatchObject({
      '@type': 'Organization',
      name: 'InfraOpsX',
      url: 'https://infra.oeax.de/about/'
    });

    await page.goto('/zh/blog/rook-ceph-osd-high-memory-osd-memory-target/');
    await expect(page.locator('.article-meta .article-author a')).toHaveAttribute(
      'href',
      '/zh/about/'
    );
  });


  test('pages expose large social sharing metadata', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      'https://infra.oeax.de/og-default.png'
    );
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image'
    );
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
      'content',
      'https://infra.oeax.de/og-default.png'
    );

    const imageResponse = await page.request.get('/og-default.png');
    expect(imageResponse.ok()).toBeTruthy();
    expect(imageResponse.headers()['content-type']).toContain('image/png');
  });

  test('BlogPosting structured data includes the social image', async ({ page }) => {
    await page.goto('/blog/rook-ceph-osd-high-memory-osd-memory-target/');

    const structuredData = await readStructuredData(page);
    const article = structuredData.find((node) => node['@type'] === 'BlogPosting');

    expect(article.image).toBe('https://infra.oeax.de/og-default.png');
  });

  test('article language switch preserves the matching article', async ({ page }) => {
    await page.goto('/blog/rook-ceph-osd-high-memory-osd-memory-target/');

    const languageSwitch = page.locator('.desktop-nav .language-switch');
    await expect(languageSwitch).toHaveAttribute(
      'href',
      '/zh/blog/rook-ceph-osd-high-memory-osd-memory-target/'
    );

    await languageSwitch.click();
    await expect(page).toHaveURL(/\/zh\/blog\/rook-ceph-osd-high-memory-osd-memory-target\/$/);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: /Rook Ceph OSD 内存占用过高/
      })
    ).toBeVisible();
  });

  test('theme preference can be changed and persisted', async ({ page }) => {
    await page.goto('/');

    await page.locator('details[data-theme-menu="desktop"] > summary').click();
    await page.locator('[data-theme-menu="desktop"] [data-theme-choice="dark"]').click();

    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');

    const storedTheme = await page.evaluate(() => localStorage.getItem('infraopsx-theme'));
    expect(storedTheme).toBe('dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
  });

  test('article code blocks expose working copy controls', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/blog/kubeadm-kubernetes-v1-27-to-v1-37-upgrade/');

    const firstCode = page.locator('.article-content pre').first();
    const copyButton = firstCode.locator('.code-copy-button');

    await expect(copyButton).toBeVisible();
    await expect(copyButton).toHaveText('Copy');

    const expected = await firstCode.locator('code').innerText();
    await copyButton.click();

    await expect(copyButton).toHaveText('Copied');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(expected);
  });

  test('article does not overflow the mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/zh/blog/kubeadm-kubernetes-v1-27-to-v1-37-upgrade/');

    const sizes = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth
    }));

    expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
    expect(sizes.body).toBeLessThanOrEqual(sizes.viewport + 1);
  });

  test('mobile navigation opens and exposes primary links', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.locator('.mobile-menu-toggle').click();
    await expect(page.locator('.mobile-nav')).toBeVisible();
    await expect(page.locator('.mobile-nav').getByRole('link', { name: 'Tools' })).toBeVisible();
    await expect(page.locator('.mobile-nav').getByRole('link', { name: 'Articles' })).toBeVisible();
  });
});

test.describe('site search', () => {
  test('searches the production Pagefind index', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await page.goto('/search/');

    await page.locator('[data-search-input]').fill('Ceph');

    await expect(page.locator('[data-search-summary]')).not.toHaveText('Searching…');
    await expect(page.locator('[data-search-results]')).toBeVisible();
    await expect(page.locator('[data-search-results] a').first()).toBeVisible();

    const resultText = await page.locator('[data-search-results]').innerText();
    expect(resultText.toLowerCase()).toContain('ceph');
    expect(errors).toEqual([]);
  });
});

test.describe('interactive tools', () => {
  test('Ceph capacity calculator updates browser-local results', async ({ page }) => {
    await page.goto('/tools/ceph-capacity-calculator/');

    await page.locator('[data-input="osdCount"]').fill('9');
    await page.getByRole('button', { name: 'Calculate capacity' }).click();

    await expect(page.locator('[data-result="raw"]')).toHaveText('36 TB');
    await expect(page.locator('[data-result="theoretical"]')).toHaveText('12 TB');
    await expect(page.locator('[data-result="recommended"]')).toHaveText('10.2 TB');
  });

  test('Kubernetes resource calculator recalculates node requirements', async ({ page }) => {
    await page.goto('/tools/kubernetes-resource-calculator/');

    await page.locator('[data-input="replicas"]').fill('20');
    await page.getByRole('button', { name: 'Calculate resources' }).click();

    await expect(page.locator('[data-result="totalCpuRequests"]')).toHaveText('5 CPU cores');
    await expect(page.locator('[data-result="minimumNodes"]')).toHaveText('2');
    await expect(page.locator('[data-result="fit"]')).toHaveText('Fits');
  });

  test('Kubernetes quantity converter converts CPU quantities', async ({ page }) => {
    await page.goto('/tools/kubernetes-quantity-converter/');

    await page.locator('[data-quantity-input]').fill('0.5');
    await page.getByRole('button', { name: 'Convert' }).click();

    await expect(page.locator('[data-cpu-cores]')).toHaveText('0.5');
    await expect(page.locator('[data-millicpu]')).toHaveText('500');
    await expect(page.locator('[data-recommended]')).toHaveText('500m');
  });
});
