# strive2-ci

Shared CI workflows and scripts for the Strive2 platform. Used by [api](https://github.com/Simas-Zurauskas/strive2-api) and [client](https://github.com/Simas-Zurauskas/strive2-client) repos via GitHub reusable workflows.

## What It Does

On every push to master, two Notion documentation syncs run automatically:

1. **Technical sync** — Updates [Technical](https://www.notion.so/336c2628ef9581bf8806d8b738a2d8eb) pages with code-level detail (architecture, schemas, endpoints, conventions)
2. **Product sync** — Updates [How Strive Works](https://www.notion.so/338c2628ef9581c1afd6de5c29af8bd1) pages with product-level descriptions (user flows, business logic, feature mechanics)

Both use Claude Sonnet to assess the diff, decide which pages need updating, and generate the content in the appropriate style. Technical docs reference code directly; product docs never mention file paths, function names, or endpoints.

Full rebuilds can be triggered manually for both sections.

## Workflows

| Workflow                       | Trigger         | Purpose                                             |
| ------------------------------ | --------------- | --------------------------------------------------- |
| `notion-sync-technical.yml`    | Push to master  | Incremental technical doc sync (assess diff → write) |
| `notion-sync-product.yml`      | Push to master  | Incremental product doc sync (assess diff → write)   |
| `notion-rebuild-technical.yml` | Manual dispatch | Full technical docs rebuild via multi-agent orchestration |
| `notion-rebuild-product.yml`   | Manual dispatch | Full product docs rebuild via multi-agent orchestration  |

## Usage

Each reusable workflow takes a `notion_root_id` input — the Notion page ID it should sync to. It's just an identifier (not a secret), so pass it inline:

```yaml
# .github/workflows/notion-sync.yml
name: "Knowledge Base: Sync"
on:
  push:
    branches: [master]
  workflow_dispatch:

jobs:
  sync-technical:
    uses: Simas-Zurauskas/strive2-ci/.github/workflows/notion-sync-technical.yml@master
    with:
      notion_root_id: 336c2628-ef95-81bf-8806-d8b738a2d8eb
    secrets: inherit
  sync-product:
    uses: Simas-Zurauskas/strive2-ci/.github/workflows/notion-sync-product.yml@master
    with:
      notion_root_id: 338c2628-ef95-81c1-afd6-de5c29af8bd1
    secrets: inherit
```

```yaml
# .github/workflows/notion-rebuild.yml
name: "Knowledge Base: Rebuild"
on:
  workflow_dispatch:

jobs:
  rebuild-technical:
    uses: Simas-Zurauskas/strive2-ci/.github/workflows/notion-rebuild-technical.yml@master
    with:
      notion_root_id: 336c2628-ef95-81bf-8806-d8b738a2d8eb
    secrets: inherit
  rebuild-product:
    uses: Simas-Zurauskas/strive2-ci/.github/workflows/notion-rebuild-product.yml@master
    with:
      notion_root_id: 338c2628-ef95-81c1-afd6-de5c29af8bd1
    secrets: inherit
```

### Known root page IDs

| Section          | Notion page ID                         |
| ---------------- | -------------------------------------- |
| Technical        | `336c2628-ef95-81bf-8806-d8b738a2d8eb` |
| How Strive Works | `338c2628-ef95-81c1-afd6-de5c29af8bd1` |

## Required Secrets (set in each consumer repo)

Settings → Secrets and variables → Actions → Secrets:

| Secret              | Used by              | Value                    |
| ------------------- | -------------------- | ------------------------ |
| `ANTHROPIC_API_KEY` | All syncs + rebuilds | Anthropic API key        |
| `NOTION_API_KEY`    | All syncs + rebuilds | Notion integration token |

## Scripts

All scripts live in `scripts/` and are checked out at runtime by the reusable workflows.

### Sync (incremental, per push)

| Script                       | Purpose                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `notion-sync-technical.js`   | AI-driven technical doc sync — assesses diff, rewrites/creates Technical pages      |
| `notion-sync-product.js`     | AI-driven product doc sync — assesses diff, rewrites/creates How Strive Works pages |

### Rebuild (full, manual dispatch)

| Script                      | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `rebuild-docs-technical.js` | Multi-agent full technical documentation rebuild             |
| `rebuild-docs-product.js`   | Multi-agent full product documentation rebuild               |

### Standards

| Script                       | Purpose                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `doc-standards-technical.js` | Writing standards for technical docs (verification rules, quality criteria) |
| `doc-standards-product.js`   | Writing standards for product docs (no code references, verification rules) |

### Shared

| Script              | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `fetch-notion-docs.js` | Fetches Notion page tree as markdown (used by sync + rebuild) |
| `notion-tool.js`    | CLI for Notion CRUD operations (rewrite, create, delete, rename) |
| `lib/agent.js`      | Claude API wrapper for structured output via claude-agent-sdk    |
| `lib/schemas.js`    | JSON schemas for agent structured outputs (assess, generate, plan, worker) |
| `lib/docs.js`       | File system helpers for reading and indexing local documentation  |
| `lib/notion-writer.js` | Writes documentation changes to Notion via notion-tool.js     |
| `lib/log-helpers.js`| Formatting and logging utilities for CI output                   |
