import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://infra.oeax.de',
  output: 'static',
  integrations: [
    sitemap({
      filter: (page) =>
        page !== 'https://infra.oeax.de/search/' &&
        page !== 'https://infra.oeax.de/zh/search/'
    })
  ]
});
