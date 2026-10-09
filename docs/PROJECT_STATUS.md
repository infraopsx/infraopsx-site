# InfraOpsX Project Status

Last updated: 2026-09-30

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
- Playwright browser E2E tests

Production ingress is separated from the site container:

- a host-level Edge Nginx stack owns public ports 80/443 and origin TLS
- the InfraOpsX container serves internal HTTP on port 80
- Edge Nginx reaches InfraOpsX through the external Docker `edge` network
- the InfraOpsX deployment workflow changes only the image tag and does not replace host Edge, Compose, or TLS configuration

Pull request CI validates the production Docker image, Nginx configuration, and a Chromium-based Playwright E2E suite against the built production image.

The E2E suite currently covers:

- important English and Chinese routes
- article language switching
- desktop theme persistence
- mobile navigation
- Pagefind site search
- Ceph Capacity Calculator
- Kubernetes Resource Calculator
- Kubernetes Quantity Converter
- browser console and page errors on core smoke routes
- home-page Organization / WebSite structured data
- article author attribution and BlogPosting author metadata
- Open Graph / Twitter social image metadata and asset delivery
- sitemap-driven SEO regression checks for canonical URLs, title/description, reciprocal hreflang, x-default and indexability
- explicit search-page noindex and sitemap-exclusion checks
- failure screenshots, video, and Playwright traces

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
- Planning Capacity After Reserve (user-selected planning reserve, not Ceph MAX AVAIL)
- Data Efficiency
- Redundancy Overhead
- configurable Reserve
- deterministic, unit-tested Replicated and EC capacity model
- optional basic OSD/Host failure-domain count check (necessary condition only; not actual CRUSH validation)
- explicit validation of blank, non-finite and out-of-range inputs
- client-side input validation
- bilingual interface
- local browser calculation

All calculator inputs are processed locally in the browser.

No calculator input is uploaded to a server.

Ceph capacity outputs assume equal-capacity OSDs and omit cluster utilization, CRUSH placement, BlueStore/metadata overhead, device class restrictions and recovery headroom. The tool does not calculate Ceph `df` `MAX AVAIL` or assert safe writable space.

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
- WebSite and Organization JSON-LD on the home page
- BlogPosting JSON-LD on article pages
- visible article author attribution linked to About
- BlogPosting author metadata
- BreadcrumbList JSON-LD on article pages
- article Open Graph type on article pages
- default 1200×630 PNG social sharing image
- og:image and Twitter summary_large_image metadata
- BlogPosting image metadata
- automated SEO regression coverage in Playwright for sitemap-discovered public routes

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

`Tool development and browser regression coverage`

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
