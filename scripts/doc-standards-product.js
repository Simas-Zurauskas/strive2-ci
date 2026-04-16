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

const VERIFICATION_RULES = `
## Verification Rules

Product documentation describes behavior in plain language, but the source of truth
is the code. Every behavioral claim must be verified — not assumed, not inferred
from naming conventions, not carried over from a scan summary.

- **Trace every user flow through the code.** When documenting "the user signs up
  with email and password," read the signup validation schema and controller. Note
  exactly what fields are required and what errors can occur. Do not add fields
  that the schema does not include.
- **Verify every business rule against its source.** When documenting thresholds
  (mastery tiers, XP values, intervals, level formulas), find the constant or logic
  in the code and confirm the exact value. Do not round or paraphrase.
- **Check what happens on failure, not just success.** When documenting a feature,
  check what happens when validation fails or a prerequisite is not met. Document
  the actual behavior, not the expected behavior.
- **Verify UI claims against the component.** When writing "the dashboard shows a
  90-day activity heatmap," read the component and check the actual date range.
- **Enumerate, do not estimate.** When stating counts (question count, achievement
  count, content block types), count the items in the source.
`.trim();

const QUALITY_CRITERIA = `
## Quality Criteria

Every page must meet four standards:

**COMPLETE** — All user-facing features and business rules in the documented
scope are covered. Nothing a user would encounter is silently omitted.

**HELPFUL** — Explains how features work and why they exist. Includes the user
experience, edge cases, and how different parts of the system connect. A reader
should understand the product deeply without reading any code.

**ACCESSIBLE** — Readable without any code knowledge. If a developer, a product
manager, and a CEO all read this page, all three should find it useful. No
unexplained jargon, no assumed technical knowledge.

**VERIFIED** — Every feature description was verified by reading the source code
that implements it. Every count, threshold, and interval was confirmed against the
actual value in code. Every user flow was traced through the actual code path.
See Verification Rules.
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

- **Cross-page links (See Also, etc.):** Use Notion URLs built from the page ID.
  The page IDs are shown in the documentation outline as \`[page-id]\`.
  Format: \`[Page Title](https://www.notion.so/<page-id-without-dashes>)\`
  - Example: if the page ID is \`338c2628-ef95-81a1-94ab-d85b9fd47bec\`, link as:
    \`[Learning Experience & Progress](https://www.notion.so/338c2628ef9581a194abd85b9fd47bec)\`
- **Do NOT use relative links** like \`[text](./path)\` or \`[text](#anchor)\`
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
  VERIFICATION_RULES,
  QUALITY_CRITERIA,
  PAGE_STRUCTURE,
  LINK_STANDARDS,
  UPDATE_RULES,
};
