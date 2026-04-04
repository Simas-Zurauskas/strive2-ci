/**
 * doc-standards.js — Shared documentation standards for sync and rebuild scripts.
 *
 * These standards mirror initWikiPrompt.md to ensure consistent documentation
 * quality across all entry points: manual wiki generation, full rebuild, and
 * incremental sync.
 */

const DOCUMENTATION_PHILOSOPHY = `
## Documentation Philosophy

Write documentation that is professional, precise, and useful — not exhaustive for
its own sake. Every page must earn its place. Ask yourself: would a developer joining
this project tomorrow find this useful, or is it noise?

Focus on what matters: architecture decisions, data flows, integration points, gotchas,
and configuration. Do not restate obvious code. If a function's name and signature
already tell the full story, do not document it — document the things that are not
self-evident.

Your thinking must go beyond individual files. Consider:
- What does this code mean architecturally?
- How do different parts of the system integrate with each other?
- What data contracts, API shapes, auth flows, or conventions exist across boundaries?
- What would be confusing or surprising to someone reading this codebase for the first time?

Cross-boundary concerns are first-class topics. Authentication flows that span
multiple packages, shared data contracts, API versioning agreements, deployment
dependencies — these must be explicitly documented, not buried inside a single section.
`.trim();

const WRITING_STANDARDS = `
## Writing Standards

- Present tense, third person ("The component accepts…", "Authentication uses…")
- Name specific files, components, functions, endpoints — no vague references
- Dense and precise. Every sentence must carry information. Cut filler.
- Use code blocks for paths, component names, env vars, commands
- Use tables for structured data (props, routes, env vars, config options)
- Use headings and short paragraphs — no walls of text
- Technical, direct, professional tone
`.trim();

const QUALITY_CRITERIA = `
## Quality Criteria

Every page must meet three standards:

**COMPLETE** — All public functions, hooks, components, routes, endpoints, and
models in the documented scope are covered. Nothing significant is silently omitted.

**HELPFUL** — Explains why, not just what. Includes gotchas, integration points,
and the reasoning behind non-obvious decisions. A reader should understand not just
what the code does but why it was built this way.

**TRUTHFUL** — Every file path, function name, prop, parameter, and behavior claim
matches the actual code. If you have not verified it by reading the source, do not
write it. If something is unclear from the codebase alone, note it explicitly rather
than guessing.
`.trim();

const PAGE_STRUCTURE = `
## Page Structure

Each documentation page should include the following sections where applicable.
Not every page needs every section — omit sections that would be empty or forced.

- **Purpose** — One paragraph explaining what this part of the system does and why it exists.
- **How it works** — Core technical content. The meat of the page.
- **Key files** — Table of file paths with one-line descriptions.
- **Integration points** — How this connects to other parts of the system. Links to relevant pages.
- **Configuration** — Environment variables, feature flags, config files.
- **Gotchas** — Non-obvious behavior, limitations, edge cases, known issues.
`.trim();

const LINK_STANDARDS = `
## Link Standards (Notion compatibility)

The markdown you produce is converted to Notion blocks. Notion rejects any link that is
not a valid absolute URL (with protocol).

- **Do NOT use markdown links for file paths.** Use inline code instead.
  - Bad: \`[UserModel](src/models/User.ts)\`
  - Good: \`\`src/models/User.ts\`\`
- **Do NOT use relative links** like \`[text](./path)\` or \`[text](#anchor)\`
- **Only use markdown links for real absolute URLs** — e.g. \`[Docs](https://example.com)\`
- Use inline code (\\\`backticks\\\`) for file paths, function names, environment variables,
  and any other code references
`.trim();

const UPDATE_RULES = `
## When to Update Documentation

**Update when:** New features, architectural changes, API changes, new conventions,
new integrations, or changes to configuration.

**Do NOT update for:** Bug fixes, minor refactors, dependency bumps, formatting changes,
test-only changes, or changes that follow established patterns without introducing new ones.

**Always rewrite pages fully** rather than appending. Appending causes duplication and
drift over time. When a page needs updating, produce the complete page content with the
new information integrated — not a patch appended to the bottom.
`.trim();

module.exports = {
  DOCUMENTATION_PHILOSOPHY,
  WRITING_STANDARDS,
  QUALITY_CRITERIA,
  PAGE_STRUCTURE,
  LINK_STANDARDS,
  UPDATE_RULES,
};
