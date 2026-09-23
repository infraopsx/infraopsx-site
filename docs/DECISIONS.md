# InfraOpsX Project Decisions

This document records long-term technical and product decisions.

It is not a changelog.

---

## ADR-001: Static-first architecture

### Decision

InfraOpsX remains a static Astro site by default.

Interactive tools should use browser JavaScript when practical.

### Why

This provides:

- low infrastructure cost
- simple deployment
- strong reliability
- good performance
- easy CDN caching
- reduced operational maintenance

A backend should only be introduced when a feature genuinely requires server-side execution.

---

## ADR-002: English primary, Chinese localization

### Decision

English is the primary site language.

Chinese versions of important pages live under `/zh/`.

### Implementation

English:

`/tools/...`

Chinese:

`/zh/tools/...`

Shared components and shared business logic are preferred.

### Why

This avoids maintaining two independent implementations and reduces localization drift.

---

## ADR-003: Keep established infrastructure terminology

### Decision

Established technical terminology should not be translated awkwardly.

Examples:

- Kubernetes
- Ceph
- OSD
- CRUSH
- BlueStore
- Replication
- Erasure Coding
- Raw Capacity

Chinese explanations may mix Chinese prose with these technical terms when that is more natural for infrastructure engineers.

### Why

Accuracy and readability for technical users are more important than literal translation.

---

## ADR-004: Browser-local tools by default

### Decision

Simple calculators, converters, validators, and generators should run locally in the browser.

### Why

Benefits include:

- no backend cost
- no API dependency
- lower latency
- better privacy
- easier scaling
- simpler deployment

Calculator inputs should not be uploaded unless a future feature explicitly requires server-side processing.

---

## ADR-005: No AI dependency for basic tools

### Decision

V1 infrastructure tools should not require an LLM or AI backend.

Calculations, validations, and explanations should be deterministic where possible.

### Why

For infrastructure calculations, deterministic results are faster, cheaper, easier to verify, more trustworthy, and easier to maintain.

AI may be added later as an optional user-triggered feature when it provides clear value.

---

## ADR-006: SEO pages must remain useful without JavaScript

### Decision

Important titles, descriptions, documentation, FAQ content, and explanatory text should exist in generated HTML.

JavaScript may enhance tools but should not be responsible for rendering all meaningful page content.

### Why

This improves search indexing, accessibility, resilience, and initial page rendering.

---

## ADR-007: No unnecessary dependencies

### Decision

Prefer the existing Astro and browser platform capabilities.

Do not introduce new npm dependencies for functionality that can reasonably be implemented with the existing stack.

### Why

This reduces dependency risk, image size, build complexity, maintenance overhead, and security exposure.

---

## ADR-008: Feature branch and PR workflow

### Decision

Changes should not be developed directly on `main`.

Use focused branches such as:

- `feat/...`
- `fix/...`
- `chore/...`

Run validation before merging.

### Expected checks

At minimum:

```bash
git diff --check
```

For site changes:

```bash
cd site
npm run build
```

Use a PR for changes going into `main`.

---

## ADR-009: InfraOpsX Tools should solve practical operator problems

### Decision

Tool development should prioritize problems encountered by infrastructure, Linux, Kubernetes, Docker, Ceph, and DevOps users.

Preferred tool types:

- calculators
- converters
- validators
- generators
- inspectors

### Why

The Tools section should reinforce InfraOpsX's technical positioning rather than becoming a generic collection of unrelated utilities.

---

## ADR-010: Avoid duplicate status and changelog documentation

### Decision

Do not maintain a manual `UPDATE.md` or detailed `CHANGELOG.md` at this stage.

Use:

- Git history and PRs for change history
- `PROJECT_STATUS.md` for current state
- `DECISIONS.md` for long-term decisions
- `AGENTS.md` for agent operating rules

### Why

This avoids duplicated documentation that quickly becomes stale.

---

## ADR-011: Centralized Tools catalog

### Decision

Tools metadata is maintained in one centralized catalog. The English and Chinese Tools discovery pages derive their localized cards, categories, links, and search index from that same source. Planned entries have no generated route or link.

### Why

A single catalog prevents language metadata drift and keeps future Tools discovery changes data-driven without duplicating page logic.

---

## ADR-012: Static site-wide Pagefind search

### Decision

Pagefind remains the static search engine for site-wide search. Content pages explicitly opt into the index through `data-pagefind-body` and expose stable content-type filters for `Article`, `Tool`, `Case Study`, and `Portfolio`. English and Chinese results follow each page's `html lang` value rather than using a custom cross-language index. The Tools catalog keeps its existing browser-local search independently from site-wide search.

### Why

This keeps search lightweight and build-time generated while preventing navigation, utility pages, unfinished tools, and listing-page chrome from becoming search results. A shared localized UI can filter the same static Pagefind data without introducing a backend or another runtime dependency.
