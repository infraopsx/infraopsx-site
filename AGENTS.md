# InfraOpsX Agent Guide

This file defines the long-term rules for coding agents working on this repository.

Before starting a task:

1. Read this file.
2. Read `docs/PROJECT_STATUS.md`.
3. Read `docs/DECISIONS.md` when the task involves architecture, tooling, localization, SEO, or deployment decisions.
4. Inspect the current code before making assumptions.

## Project

InfraOpsX is a bilingual infrastructure and DevOps website.

Primary topics include:

- Linux
- Docker
- Kubernetes
- Ceph
- Nginx
- Prometheus / Grafana
- DevOps and infrastructure troubleshooting
- Browser-based infrastructure tools

The site is primarily static and should remain lightweight.

## Technology

Current stack:

- Astro
- Static site generation
- Browser JavaScript for interactive tools
- Nginx
- Docker
- GitHub Actions
- GHCR
- Cloudflare
- Pagefind

Do not introduce React, Vue, a backend service, database, or additional runtime infrastructure unless explicitly requested.

## Repository Structure

Important areas:

- `site/src/pages/` — English pages
- `site/src/pages/zh/` — Chinese pages
- `site/src/components/` — shared components
- `site/src/components/tools/` — shared tool logic
- `site/src/styles/global.css` — global site styles
- `docs/PROJECT_STATUS.md` — current project state
- `docs/DECISIONS.md` — established project decisions

## Localization

English is the primary version.

Chinese pages live under `/zh/`.

When adding a public page, normally create both an English route and a Chinese route.

Prefer shared components and shared logic.

Do not duplicate calculator or business logic between English and Chinese pages.

### Technical terminology

Do not force awkward Chinese translations for established technical terms.

Terms that may remain in English include:

- Kubernetes
- Docker
- Ceph
- OSD
- CRUSH
- BlueStore
- Replication
- Replication Size
- Erasure Coding
- EC
- Raw Capacity
- Usable Capacity
- Data Efficiency
- Recovery
- Backfill

Normal UI text and explanatory prose should still be naturally localized.

Avoid unnecessary English section headings on Chinese pages when the text is not a technical term.

## English Copy

English content must read like natural technical English.

Avoid literal Chinese-to-English translation, unnecessary Title Case in normal sentences, awkward noun stacking, and unnatural articles or prepositions.

UI labels may use Title Case. Normal prose should use standard sentence capitalization.

## Tools

Simple tools should be client-side by default.

Preferred tool categories:

- Calculator
- Converter
- Validator
- Generator
- Inspector

For calculators and converters:

- perform calculations in the browser
- do not upload user inputs
- do not add a backend unless required
- do not add AI calls unless explicitly requested
- validate inputs before updating results
- keep formulas deterministic and inspectable

For a new tool, prefer:

- `/tools/<tool-name>/`
- `/zh/tools/<tool-name>/`
- a shared component under `site/src/components/tools/`

Tool pages should generally contain:

1. Breadcrumb
2. Title and short description
3. Main tool UI
4. Result or analysis summary
5. How it works
6. Important considerations
7. FAQ
8. Related tools
9. Contact CTA

## SEO

Every important English/Chinese page pair should have correct:

- title
- description
- canonical URL
- `hreflang="en"`
- `hreflang="zh-CN"`
- `x-default`

Important content should be present in generated HTML and should not depend entirely on client-side JavaScript.

Do not use keyword stuffing or low-value AI-generated SEO content.

## Styling

Maintain the existing InfraOpsX visual language.

Prefer existing CSS variables, spacing, container conventions, dark infrastructure-oriented design, cyan accents, and responsive layouts.

Do not redesign unrelated pages while implementing a focused task.

Avoid adding large new CSS frameworks.

## Dependencies

Do not add npm dependencies unless they provide clear value and the task cannot reasonably be implemented with the existing stack.

If a dependency is necessary, explain why.

## Git Workflow

Never work directly on `main`.

Typical workflow:

1. Update `main`
2. Create a feature/chore branch
3. Make focused changes
4. Build and test
5. Commit
6. Push only when requested or when the task explicitly includes pushing
7. Create a PR
8. Merge after checks pass

Do not push, merge, or create a PR unless the user explicitly asks for it.

Do not rewrite unrelated history.

## Validation Before Completion

For code changes, run at minimum:

```bash
git diff --check
```

For site changes, also run:

```bash
cd site
npm run build
```

If Node/npm is unavailable on the host, use the repository's existing Docker build workflow.

Before reporting completion, inspect:

```bash
git status
git diff --stat
```

For user-facing tools, also verify default values, formulas, invalid inputs, language switch, English and Chinese routes, desktop layout, mobile layout, console errors, and links.

## Scope Discipline

Make the smallest change that correctly solves the task.

Do not:

- refactor unrelated code
- redesign unrelated pages
- add speculative features
- add AI merely because it is available
- create fake links for unfinished tools
- translate established infrastructure terminology awkwardly

## Documentation Updates

After completing a significant feature, update `docs/PROJECT_STATUS.md`.

Update `docs/DECISIONS.md` only when a meaningful long-term technical or product decision has been made.

Do not turn these documents into a commit-by-commit changelog.
