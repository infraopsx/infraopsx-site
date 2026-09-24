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

SEO work must follow current Google Search Central best practices and remain people-first. Do not treat SEO checks as a guarantee of ranking, indexing, snippets, or rich results.

### SEO Acceptance Checklist

For every new or materially changed important public page, verify the following before completion.

#### Content and search intent

- Write for users first. The page must provide useful, reliable, original value for the intended audience.
- Do not create pages primarily to manipulate rankings.
- Do not use keyword stuffing, boilerplate SEO text, doorway-style pages, or large volumes of low-value near-duplicate content.
- Use relevant search terms naturally where they help users understand the page.
- Technical claims, examples, and page copy must accurately describe what the page actually provides.

#### Title, H1, and description

- Give each important page a descriptive, concise, and reasonably unique `<title>`.
- Use a clear primary H1 that matches the page topic and visible content.
- Keep the title, H1, description, and body aligned without mechanically repeating keywords.
- Provide a useful, page-specific meta description for important pages.
- Treat the meta description as a suggestion to search engines; Google may generate a different search snippet.

#### Canonical URLs

- Important indexable pages should have the intended canonical URL.
- Normal standalone pages should generally use a self-referential canonical.
- Canonical URLs must point to real, indexable final URLs.
- Do not use URL fragments as canonical URLs.
- Treat `rel="canonical"` as a canonicalization signal, not a guarantee that Google will select that URL.

#### English / Chinese localization

For important EN/ZH page pairs:

- Provide reciprocal alternates for the English and Chinese versions.
- Each page must also reference itself in the hreflang set.
- Follow the current project convention:
  - `hreflang="en"`
  - `hreflang="zh-CN"`
  - `hreflang="x-default"`
- Alternate URLs must resolve to real corresponding pages.
- Do not create a nominal localization where only navigation or chrome is translated while the primary content remains untranslated.
- Use hreflang to describe language/region alternatives; do not describe it as preventing another language page from being indexed.

#### Crawlability and indexability

- Important public pages must not accidentally contain `noindex`.
- Do not accidentally block important pages through `robots.txt`.
- Important internal navigation must use crawlable `<a href="...">` links.
- Use concise, descriptive anchor text instead of vague text such as "click here".
- Important new pages should be discoverable through normal site navigation, relevant internal links, or both.
- Include pages intended for search discovery in the sitemap according to the existing site build.
- Do not create fake links to unfinished destinations.
- A sitemap helps discovery and crawling; it does not guarantee crawling or indexing.

#### Static HTML

- Important SEO content must exist in generated HTML.
- Titles, descriptions, H1s, introductions, documentation, important considerations, FAQ content, and other essential explanatory copy must not depend entirely on client-side JavaScript.
- Browser JavaScript may power calculators and tools, but the page must remain understandable and useful from its generated HTML.

#### Structured data

- Add structured data only when the visible page genuinely matches the selected type.
- Structured data must describe content visible to users and must not be misleading.
- Do not fabricate authors, publication dates, modification dates, ratings, reviews, or other properties.
- For article content, prefer an appropriate supported `Article` or `BlogPosting` model when implemented.
- When a visible breadcrumb exists and structured data is added, use `BreadcrumbList` accurately.
- Prefer JSON-LD when it fits the current implementation.
- Structured data can make a page eligible for supported search features; it does not guarantee a rich result.

#### Internal and external links

- Add internal links only when they are useful and contextually relevant.
- Prefer descriptive anchors that explain the destination.
- Connect related Articles, Tools, Case Studies, Services, and Portfolio pages when the relationship is genuine.
- Avoid repetitive or artificial link blocks created only for SEO.
- Link to trustworthy external references when they materially help the reader.
- Do not add `nofollow` merely because a link is external; use link qualifications only when their actual semantics require them.

#### Page experience

- Public pages must work on mobile and desktop.
- Avoid obvious horizontal overflow, broken controls, intrusive UI, and layouts that obscure the main content.
- Avoid unnecessary large dependencies and client-side JavaScript.
- Consider Core Web Vitals and overall page experience when changes can materially affect loading, responsiveness, or visual stability.
- Do not claim that any single performance metric guarantees rankings.

#### InfraOpsX search integration

- Important searchable content should follow the project's Pagefind conventions.
- Dynamic user-input areas may be excluded from Pagefind, but useful static explanations should remain searchable.
- Confirm that new public routes, sitemap output, Pagefind behavior, and localized routes follow the existing project conventions.

#### SEO validation before completion

For a new or materially changed important public page, verify as applicable:

- generated HTML contains the intended title and meta description
- canonical URL is correct
- EN/ZH hreflang and x-default references are correct
- no accidental `noindex` or crawl blocking exists
- important internal links use real `href` values
- intended indexable routes appear in the sitemap
- meaningful explanatory content exists in generated HTML
- Pagefind includes or excludes content intentionally
- desktop and mobile layouts have no obvious regressions
- browser console has no relevant errors
- Docker production build succeeds

Do not describe these checks as a promise of Google ranking or indexing.

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

For uncommitted changes:

```bash
git diff --check
git diff --stat
git status --short
```

For committed changes, review the complete branch diff against `main`:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

For site changes, validation is Docker-first by default.

- Do not require Node/npm to be installed on the host.
- Do not run `npm install`, `npm ci`, `npm run ...`, or `npx ...` directly on the host by default.
- The presence of host Node/npm is not a reason to use it.
- Keep npm scripts as project entry points, but run the relevant scripts inside the Docker builder image.
- Use host Node/npm only when the user explicitly requests it.

Prefer the repository's Docker workflow:

```bash
# Build the reusable builder image.
docker build --target builder -t infraopsx-site:builder .

# Run the test or validation script relevant to the current task.
docker run --rm infraopsx-site:builder npm run <relevant-script>

# Validate the complete production image.
docker build -t infraopsx-site:ci .

# Start the local site for browser acceptance checks.
docker compose -f docker-compose.dev.yml up -d --build
```

If a task needs multiple npm scripts, run each relevant script inside the builder container rather than falling back to host npm.

For user-facing tools, also verify default values, formulas, invalid inputs, language switch, English and Chinese routes, desktop layout, mobile layout, console errors, and links using the local Docker Compose site.

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
