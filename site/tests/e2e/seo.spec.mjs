import { expect, test } from '@playwright/test';

const productionOrigin = 'https://infra.oeax.de';

const tags = (html, name) =>
  html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];

const attribute = (tag, name) => {
  const match = tag.match(
    new RegExp(`\\b${name}=(["'])(.*?)\\1`, 'i')
  );

  return match?.[2];
};

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

const readSeoMetadata = (html) => {
  const title = html.match(/<title>([\\s\\S]*?)<\/title>/i)?.[1]?.trim() || '';
  const htmlTag = tags(html, 'html')[0] || '';
  const linkTags = tags(html, 'link');
  const metaTags = tags(html, 'meta');

  const canonicalTags = linkTags.filter(
    (tag) => attribute(tag, 'rel') === 'canonical'
  );
  const hreflang = Object.fromEntries(
    linkTags
      .filter(
        (tag) =>
          attribute(tag, 'rel') === 'alternate' &&
          attribute(tag, 'hreflang')
      )
      .map((tag) => [
        attribute(tag, 'hreflang'),
        attribute(tag, 'href')
      ])
  );

  const descriptionTag = metaTags.find(
    (tag) => attribute(tag, 'name') === 'description'
  );
  const robotsTag = metaTags.find(
    (tag) => attribute(tag, 'name') === 'robots'
  );

  return {
    title,
    lang: attribute(htmlTag, 'lang'),
    description: descriptionTag
      ? attribute(descriptionTag, 'content') || ''
      : '',
    canonicalCount: canonicalTags.length,
    canonical: canonicalTags[0]
      ? attribute(canonicalTags[0], 'href')
      : undefined,
    robots: robotsTag
      ? attribute(robotsTag, 'content') || ''
      : '',
    hreflang
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

  test('all sitemap pages keep canonical, metadata and reciprocal hreflang', async ({ request }) => {
    test.setTimeout(90_000);

    const paths = await sitemapPaths(request);
    const pathSet = new Set(paths);
    const metadata = new Map();

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

      const response = await request.get(path);
      expect(response.ok(), `Failed to load ${path}`).toBeTruthy();
      expect(response.headers()['content-type']).toContain('text/html');

      const pageMetadata = readSeoMetadata(await response.text());
      metadata.set(path, pageMetadata);

      expect(pageMetadata.title, `Missing title on ${path}`).not.toBe('');
      expect(
        pageMetadata.description,
        `Missing meta description on ${path}`
      ).not.toBe('');
      expect(
        pageMetadata.canonicalCount,
        `Expected exactly one canonical on ${path}`
      ).toBe(1);
      expect(pageMetadata.canonical).toBe(productionUrl(path));
      expect(
        pageMetadata.robots.toLowerCase(),
        `Unexpected noindex on sitemap page ${path}`
      ).not.toContain('noindex');

      expect(pageMetadata.lang).toBe(
        path.startsWith('/zh/') ? 'zh-CN' : 'en'
      );

      expect(pageMetadata.hreflang.en).toBe(productionUrl(en));
      expect(pageMetadata.hreflang['zh-CN']).toBe(productionUrl(zh));
      expect(pageMetadata.hreflang['x-default']).toBe(productionUrl(en));
    }

    for (const path of paths.filter((candidate) => !candidate.startsWith('/zh/'))) {
      const { en, zh } = localizedPair(path);
      const enMetadata = metadata.get(en);
      const zhMetadata = metadata.get(zh);

      expect(enMetadata?.hreflang.en).toBe(zhMetadata?.hreflang.en);
      expect(enMetadata?.hreflang['zh-CN']).toBe(
        zhMetadata?.hreflang['zh-CN']
      );
      expect(enMetadata?.hreflang['x-default']).toBe(
        zhMetadata?.hreflang['x-default']
      );
    }
  });

  test('search pages stay noindex and outside the sitemap', async ({ request }) => {
    const paths = await sitemapPaths(request);

    expect(paths).not.toContain('/search/');
    expect(paths).not.toContain('/zh/search/');

    for (const path of ['/search/', '/zh/search/']) {
      const response = await request.get(path);
      expect(response.ok()).toBeTruthy();

      const pageMetadata = readSeoMetadata(await response.text());
      const { en, zh } = localizedPair(path);

      expect(pageMetadata.title).not.toBe('');
      expect(pageMetadata.description).not.toBe('');
      expect(pageMetadata.canonicalCount).toBe(1);
      expect(pageMetadata.canonical).toBe(productionUrl(path));
      expect(pageMetadata.robots.toLowerCase()).toContain('noindex');
      expect(pageMetadata.robots.toLowerCase()).toContain('follow');
      expect(pageMetadata.hreflang.en).toBe(productionUrl(en));
      expect(pageMetadata.hreflang['zh-CN']).toBe(productionUrl(zh));
      expect(pageMetadata.hreflang['x-default']).toBe(productionUrl(en));
    }
  });
});
