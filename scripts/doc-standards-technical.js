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

const VERIFICATION_RULES = `
## Verification Rules

Documentation errors most often come from writing what you expect the code to do
rather than what it actually does. These rules make verification a process step.

- **Counts must be enumerated.** When stating a number (endpoint count, hook count,
  model field count), enumerate the items in the source file and count them. Do not
  estimate from memory or round.
- **Flows must be traced.** When describing a multi-step process (auth flow, job
  lifecycle, generation pipeline), trace each step through the actual code path —
  function by function, file by file. Do not describe what you assume happens.
- **Conditional branches must be checked.** When describing behavior, check for
  if/else, role checks, and environment-dependent logic. Document the conditions,
  not just the happy path.
- **Lists must be exhaustive.** When listing items from a source file (exported hooks,
  model fields, enum values), read the file and include every item. If a table is
  intentionally selective, say "Key hooks include…" rather than presenting it as
  the full list.
`.trim();

const QUALITY_CRITERIA = `
## Quality Criteria

Every page must meet four standards:

**COMPLETE** — All public functions, hooks, components, routes, endpoints, and
models in the documented scope are covered. Nothing significant is silently omitted.

**HELPFUL** — Explains why, not just what. Includes gotchas, integration points,
and the reasoning behind non-obvious decisions. A reader should understand not just
what the code does but why it was built this way.

**TRUTHFUL** — Every file path, function name, prop, parameter, and behavior claim
matches the actual code. If you have not verified it by reading the source, do not
write it. If something is unclear from the codebase alone, note it explicitly rather
than guessing.

**VERIFIED** — Every count was produced by enumerating source items, not estimating.
Every flow was traced through the actual code path. Every behavioral claim was
checked for conditional branches. See Verification Rules.
`.trim();

const PAGE_STRUCTURE = `
## Page Structure

Each documentation page should include the following sections. Purpose is mandatory;
other sections should be included where applicable — omit sections that would be
empty or forced.

- **Purpose** (mandatory) — One paragraph explaining what this part of the system does
  and why it exists. Always use an explicit ## Purpose heading.
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

- **Cross-page links (Integration points, See Also, etc.):** Use Notion URLs built from the page ID.
  The page IDs are shown in the documentation outline as \`[page-id]\`.
  Format: \`[Page Title](https://www.notion.so/<page-id-without-dashes>)\`
  - Example: if the page ID is \`336c2628-ef95-81ce-bb28-c0060f125865\`, link as:
    \`[API](https://www.notion.so/336c2628ef9581cebb28c0060f125865)\`
- **Do NOT use markdown links for file paths.** Use inline code instead.
  - Bad: \`[UserModel](src/models/User.ts)\`
  - Good: \`\`src/models/User.ts\`\`
- **Do NOT use relative links** like \`[text](./path)\` or \`[text](#anchor)\`
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
  VERIFICATION_RULES,
  QUALITY_CRITERIA,
  PAGE_STRUCTURE,
  LINK_STANDARDS,
  UPDATE_RULES,
};
