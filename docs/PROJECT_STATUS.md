# InfraOpsX Project Status

Last updated: 2026-09-25

## Production Site

Primary site:

`https://infra.oeax.de`

The site is currently deployed as a static Astro website.

Current infrastructure includes:

- Astro
- Docker
- Nginx
- GitHub Actions
- GHCR
- Cloudflare
- Pagefind

The site supports both English and Chinese.

English routes use the root path.

Chinese routes use `/zh/`.

## Current Site Sections

Available sections include:

- Home
- Services
- Case Studies
- Portfolio
- Blog
- Tools
- About
- Contact
- Privacy

## Case Studies

Completed detailed case studies:

- Kubernetes Pod Scheduling Failure
- Rook Ceph RBD FailedMount Recovery

## Tools

### Catalog and discovery

The Tools section uses a centralized catalog shared by the English and Chinese Tools pages. The catalog drives localized metadata, Featured and Browse All sections, category filtering, and browser-local search across titles, descriptions, categories, and keywords.

The current public catalog contains the three completed tools below. Planned entries are shown as Coming Soon and do not generate links.

### Completed

#### Ceph Capacity Calculator

Routes:

- `/tools/ceph-capacity-calculator/`
- `/zh/tools/ceph-capacity-calculator/`

Current capabilities:

- Replicated layouts
- Erasure Coding layouts
- GB
- GiB
- TB
- TiB
- Raw Capacity
- Theoretical Usable Capacity
- Recommended Usable Capacity
- Data Efficiency
- Redundancy Overhead
- configurable Reserve
- client-side input validation
- bilingual interface
- local browser calculation

All calculator inputs are processed locally in the browser.

No calculator input is uploaded to a server.

#### Kubernetes Resource Calculator

Routes:

- `/tools/kubernetes-resource-calculator/`
- `/zh/tools/kubernetes-resource-calculator/`

Current capabilities:

- CPU and memory request/limit planning
- decimal and binary memory units
- homogeneous node-pool capacity planning
- Planning Reserve
- request-based fit status and node requirements
- Pod density and CPU / memory bottleneck analysis
- client-side input validation
- bilingual interface
- local browser calculation

#### Kubernetes Quantity Converter

Routes:

- `/tools/kubernetes-quantity-converter/`
- `/zh/tools/kubernetes-quantity-converter/`

Current capabilities:

- exact CPU and mCPU conversion
- decimal SI and binary SI memory conversion
- exact fixed-point quantity parsing with precision normalization warnings
- suspicious quantity and unit warnings
- CPU precision validation
- recommended Kubernetes quantity and YAML reference
- bilingual interface
- browser-local conversion
- cross-link to the Kubernetes Resource Calculator

## Planned Tools

Next planned tool:

`To be selected`

Possible later tools:

- Nginx Reverse Proxy Generator
- Docker Compose Inspector
- Kubernetes YAML Inspector

The exact order may change based on usefulness and implementation cost.

## Tool Development Direction

Preferred categories:

- Calculator
- Converter
- Validator
- Generator
- Inspector

Simple tools should remain static and client-side whenever practical.

Backend services should only be introduced when a feature cannot reasonably run in the browser.

## Localization

English is the primary version.

Chinese pages mirror important English pages under `/zh/`.

Shared components should be used whenever possible.

Technical terminology should remain accurate and should not be translated merely for the sake of translation.

## SEO

Current pages use:

- canonical URLs
- English / Chinese hreflang
- x-default
- sitemap
- robots.txt
- RSS
- Pagefind
- BlogPosting JSON-LD on article pages
- BreadcrumbList JSON-LD on article pages
- article Open Graph type on article pages

Google Search Console verification has been completed.

SEO work should focus on useful technical content and tools rather than large volumes of low-value pages.

## Site-wide Search

The site has a bilingual Pagefind search experience at:

- `/search/`
- `/zh/search/`

The index intentionally covers only completed Article, Tool, Case Study, and Portfolio destinations. Content-type filtering is browser-local, and the English and Chinese indexes remain separated by each page's `html lang` value. Tools catalog search remains local to the Tools section.

## Site Appearance

The shared header provides System, Light, and Dark appearance preferences in English and Chinese. System is the default and follows the operating system; an explicit choice is stored locally in the browser. Theme-dependent colors use shared semantic tokens, while terminal and code panels remain intentionally dark.

## Current Development Focus

Current website focus:

`Tool development`

Next planned tool:

`To be selected`

Reuse the layout and development conventions established by the Ceph Capacity Calculator for the next tool.

## Maintenance Notes

After a significant feature is merged:

1. Update the Completed section if necessary.
2. Update Current Development Focus.
3. Move planned items when their status changes.
4. Keep this file concise.

This file is a current-state document, not a changelog.
