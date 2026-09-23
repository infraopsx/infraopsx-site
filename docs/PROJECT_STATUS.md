# InfraOpsX Project Status

Last updated: 2026-09-23

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

## Tools

### Catalog and discovery

The Tools section uses a centralized catalog shared by the English and Chinese Tools pages. The catalog drives localized metadata, Featured and Browse All sections, category filtering, and browser-local search across titles, descriptions, categories, and keywords.

The current public catalog contains the two completed calculators below and the planned Kubernetes Quantity Converter. Planned entries are shown as Coming Soon and do not generate links.

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

## Planned Tools

Near-term priorities:

1. Kubernetes Quantity Converter

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

Google Search Console verification has been completed.

SEO work should focus on useful technical content and tools rather than large volumes of low-value pages.

## Current Development Focus

The Tools catalog and shared bilingual discovery pages are in place. The two completed calculators remain available under their paired English and Chinese routes.

The next planned tool is:

`Kubernetes Quantity Converter`

Reuse the layout and development conventions established by the Ceph Capacity Calculator for the next tool.

## Maintenance Notes

After a significant feature is merged:

1. Update the Completed section if necessary.
2. Update Current Development Focus.
3. Move planned items when their status changes.
4. Keep this file concise.

This file is a current-state document, not a changelog.
