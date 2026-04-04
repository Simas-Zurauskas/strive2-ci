/**
 * doc-standards-product.js — Documentation standards for product-level pages.
 *
 * These standards govern the "How Strive Works" pages in Notion.
 * Product docs explain what the app does, how features work, and
 * business logic — at a level readable by anyone on the team.
 *
 * For technical/code-level standards, see doc-standards-technical.js.
 */

const DOCUMENTATION_PHILOSOPHY = `
## Documentation Philosophy

Write documentation that any team member can read — developers, product managers,
leadership, or new hires. These pages explain what the product does and why, not
how the code implements it.

Focus on: user flows, feature mechanics, business logic, system relationships,
and data lifecycle. Write as if you're explaining the product to a smart colleague
who hasn't seen the codebase.

Your thinking must go beyond individual features. Consider:
- How do different features connect to create the user experience?
- What business rules govern behavior (e.g., sequential lesson generation, mastery tiers)?
- What does the user see, and what happens behind the scenes when they take an action?
- What would surprise someone learning about this product for the first time?
`.trim();

const WRITING_STANDARDS = `
## Writing Standards

- Present tense, third person ("The system generates…", "Users can…")
- Clear and accessible. Avoid jargon — explain concepts, don't name implementations
- Dense and precise. Every sentence must carry information. Cut filler.
- Use tables for structured data (feature comparisons, states, tiers)
- Use Mermaid diagrams for flows and state machines
- Use headings and short paragraphs — no walls of text
- Professional but approachable tone

**Critical rule — NO code references:**
- Never mention file paths, function names, class names, or variable names
- Never mention API endpoints or HTTP methods
- Never mention schema field names, database collections, or model names
- Never use inline code backticks for technical identifiers
- Instead, describe what happens in plain language:
  - Bad: "The \`contentValidation\` node in \`contentValidation.ts\` filters blocks"
  - Good: "After content is generated, the system validates block structure and removes placeholder stubs"
  - Bad: "\`POST /api/course/:id/clarify\` submits a job"
  - Good: "The system generates clarifying questions based on the goal"
`.trim();

const QUALITY_CRITERIA = `
## Quality Criteria

Every page must meet three standards:

**COMPLETE** — All user-facing features and business rules in the documented
scope are covered. Nothing a user would encounter is silently omitted.

**HELPFUL** — Explains how features work and why they exist. Includes the user
experience, edge cases, and how different parts of the system connect. A reader
should understand the product deeply without reading any code.

**ACCESSIBLE** — Readable without any code knowledge. If a developer, a product
manager, and a CEO all read this page, all three should find it useful. No
unexplained jargon, no assumed technical knowledge.
`.trim();

const PAGE_STRUCTURE = `
## Page Structure

Each documentation page should include the following sections where applicable.
Not every page needs every section — omit sections that would be empty or forced.

- **Opening line** — One sentence explaining what this page covers.
- **Core content** — The main explanation of how the feature/system works. Use flowcharts for complex flows.
- **Business rules** — Any logic that governs behavior (gating, ordering, scoring, scheduling).
- **See Also** — Links to related pages in this folder and in Strategy & Vision where relevant.
`.trim();

const LINK_STANDARDS = `
## Link Standards (Notion compatibility)

The markdown you produce is converted to Notion blocks. Notion rejects any link that is
not a valid absolute URL (with protocol).

- **Do NOT use markdown links for any internal references.** Just name the page or concept.
- **Do NOT use relative links** like \`[text](./path)\` or \`[text](#anchor)\`
- **Only use markdown links for real absolute URLs** — e.g. \`[Docs](https://example.com)\`
- **Never use inline code backticks** for file paths, function names, or technical identifiers.
  These don't belong in product documentation at all.
`.trim();

const UPDATE_RULES = `
## When to Update Documentation

**Update when:** A change affects what a user experiences, how a feature works,
or the business logic behind a feature. New features, changed user flows, new
content types, modified scoring/scheduling rules, new AI capabilities.

**Do NOT update for:** Bug fixes, performance optimizations, internal refactors,
dependency bumps, code cleanup, middleware changes, schema optimizations, or any
change that doesn't alter what the user sees or how a feature behaves.

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
