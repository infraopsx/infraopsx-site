import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://infra.oeax.de',
  output: 'static',
  integrations: [
    sitemap()
  ]
});
