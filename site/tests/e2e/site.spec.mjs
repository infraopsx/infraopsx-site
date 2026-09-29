import { expect, test } from '@playwright/test';

const routes = [
  ['/', 'InfraOpsX'],
  ['/zh/', 'InfraOpsX'],
  ['/blog/', 'Real problems. Practical notes.'],
  ['/zh/blog/', '真实问题，实用记录。'],
  ['/tools/', 'Infrastructure tools'],
  ['/zh/tools/', '基础设施工具'],
  ['/tools/ceph-capacity-calculator/', 'Ceph Capacity Calculator'],
  ['/tools/kubernetes-resource-calculator/', 'Kubernetes Resource Calculator'],
  ['/tools/kubernetes-quantity-converter/', 'Kubernetes Quantity Converter'],
  ['/blog/rook-ceph-osd-high-memory-osd-memory-target/', 'Rook Ceph OSD High Memory Usage'],
  ['/zh/blog/rook-ceph-osd-high-memory-osd-memory-target/', 'Rook Ceph OSD 内存占用过高']
];

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

  test('mobile navigation opens and exposes primary links', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByRole('button', { name: 'Open navigation menu' }).click();
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
