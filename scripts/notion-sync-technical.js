const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-technical');
const { label, separator, prRef, changeMeta } = require('./lib/log-helpers');
const { invokeAgent } = require('./lib/agent');
const { loadDocsIndex, buildDocsOutline, loadPageContent } = require('./lib/docs');
const { assessSchema, GENERATE_SCHEMA } = require('./lib/schemas');
const { writeResults } = require('./lib/notion-writer');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../..');
const DOCS_INDEX_PATH = path.join(REPO_ROOT, '_docs', '_index.json');
const NOTION_TOOL = path.join(SCRIPTS_DIR, 'notion-tool.js');
const CONCURRENCY = 3;
const REPO_LABEL = process.env.REPO_LABEL;

const ASSESS_SCHEMA = assessSchema(['rewrite', 'create', 'crosslink']);

// ---------------------------------------------------------------------------
// Phase 1: Assess
// ---------------------------------------------------------------------------

function buildAssessPrompt(docsOutline, diff) {
  const rootId = process.env.NOTION_TECHNICAL_ROOT_ID;

  return `You are a living documentation agent for this project.
You are operating in the **${REPO_LABEL}** repository.

${DOC_STANDARDS.DOCUMENTATION_PHILOSOPHY}

${DOC_STANDARDS.UPDATE_RULES}

DOCUMENTATION STRUCTURE
All documentation lives in Notion under two top-level sections:
- **Product** — manually curated vision, features, and strategy docs. NEVER modify these.
- **Technical** — architecture, conventions, and implementation docs. This is your scope.

The Technical section you can update (section headings per page — shows what topics are covered):
${docsOutline}

Technical root page ID: ${rootId}

CHANGE CONTEXT
Repository: ${process.env.REPO_NAME}
${prRef()}: ${process.env.PR_TITLE}
Author: ${process.env.PR_AUTHOR}
Description: ${process.env.PR_BODY || 'None provided'}

Changed files:
${process.env.CHANGED_FILES}

Diff:
${diff}

YOUR TASK

Assess whether this change requires documentation updates. You are ONLY producing a plan —
do NOT write any page content. A separate agent will handle content generation based on
your instructions.

ACTIONS

1. **rewrite** — PREFERRED for all changes. Flag an existing page for a full rewrite.
   Provide page_id and clear instructions for the content writer about what to update
   and how to integrate the changes into the existing page.

2. **create** — RARELY used. Create a new page ONLY when the change introduces a major,
   top-level system that genuinely has no home in ANY existing page. Individual features,
   agents, endpoints, or sub-systems should be documented as sections within existing
   pages (via rewrite), NOT as separate pages. When in doubt, choose rewrite.
   MUST provide parent_id (the page ID of the parent page, NOT the root), page_title,
   and instructions. Sub-pages go under their parent — e.g. an API sub-page uses the
   API page's ID as parent_id.

3. **crosslink** — Add a cross-reference note to a page when a change in this repo
   has implications for documentation in another section. Provide page_id and instructions
   describing the note to add.

CRITICAL RULES
- NEVER claim something is "not yet documented" unless you have carefully checked ALL
  existing page headings above.
- STRONGLY prefer rewriting existing pages over creating new ones. A new agent, feature,
  or endpoint should be a new SECTION in the relevant existing page, not a new page.
- If you are unsure whether to create or rewrite, always choose rewrite.
- If the change is trivial (dependency bump, formatting, minor CSS, test-only, internal
  refactor that doesn't change public behavior), set meaningful to false.

HIERARCHY RULES
- Changes to this repo's internals → under this repo's section in the tree
- Changes to how repos communicate → under the system-wide section
- Auth changes → system-wide auth page if cross-repo, repo-specific if isolated
- New external service integration → system-wide or repo-specific depending on scope
- Never create a page at root level unless it is a genuinely top-level concern

For each action, write detailed instructions explaining:
- What changed in the code and why it matters for documentation
- Which sections of the page need updating
- What the content writer should verify or emphasize`;
}

async function assess(docsOutline, diff, docsIndex = []) {
  const phaseStart = Date.now();
  console.log(chalk.cyan('Phase 1: Assess'));

  const prompt = buildAssessPrompt(docsOutline, diff);
  console.log(chalk.dim(`  Prompt: ${Math.round(prompt.length / 1024)}KB`));

  const plan = await invokeAgent({ prompt, schema: ASSESS_SCHEMA, maxTurns: 8 5 });
  const elapsed = Math.round((Date.now() - phaseStart) / 1000);

  if (!plan) {
    console.log(chalk.yellow(`  No response from assessor ${chalk.dim(`(${elapsed}s)`)}`));
    return null;
  }

  console.log(`  Meaningful: ${plan.meaningful ? chalk.green('yes') : chalk.yellow('no')} ${chalk.dim(`(${elapsed}s)`)}`);
  console.log(`  Reasoning:  ${chalk.italic(plan.reasoning)}`);

  if (plan.meaningful && plan.actions?.length) {
    const titleById = new Map(docsIndex.map((d) => [d.id, d.title]));
    for (const a of plan.actions) {
      const pageLabel = a.page_title || titleById.get(a.page_id) || a.page_id || '(new)';
      console.log(`    ${chalk.bold(a.type.padEnd(10))} ${chalk.cyan(pageLabel)}`);
      console.log(chalk.dim(`       ${a.instructions.slice(0, 120)}${a.instructions.length > 120 ? '…' : ''}`));
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Phase 2: Generate (per-page workers)
// ---------------------------------------------------------------------------

function buildWorkerPrompt(action, pageContent, diff) {
  return `You are a documentation writer for the Strive learning platform.
You have ONE job: write complete, accurate documentation for a specific page.

## Your assignment

Page: ${action.page_title || '(new page)'}
Action: ${action.type}

## Instructions from the planner

${action.instructions}

## Current page content

${pageContent || '(No existing documentation — write from scratch)'}

## Code diff that triggered this update

${diff}

${DOC_STANDARDS.WRITING_STANDARDS}

${DOC_STANDARDS.QUALITY_CRITERIA}

${DOC_STANDARDS.PAGE_STRUCTURE}

${DOC_STANDARDS.LINK_STANDARDS}

## Output

Write the COMPLETE page content as markdown. This will fully replace the existing page,
so include ALL content — both updated sections and unchanged sections.
Do not omit existing content that is still accurate.

If after reviewing the diff and current content you determine no update is actually needed,
set skipped to true with a skip_reason.`;
}

async function runWorker(action, pageContent, diff) {
  try {
    const prompt = buildWorkerPrompt(action, pageContent, diff);
    const result = await invokeAgent({ prompt, schema: GENERATE_SCHEMA, maxTurns: 8 5 });
    if (!result) {
      return { page_title: action.page_title || '', markdown: '', summary: 'Worker produced no output', skipped: true, skip_reason: 'No structured output returned' };
    }
    return result;
  } catch (err) {
    return { page_title: action.page_title || '', markdown: '', summary: `Worker error: ${err.message}`, skipped: true, skip_reason: err.message };
  }
}

async function generate(actions, docsIndex, diff) {
  const phaseStart = Date.now();
  console.log('');
  console.log(chalk.cyan('Phase 2: Generate'));

  const contentActions = actions.filter((a) => a.type !== 'crosslink');
  const crosslinks = actions.filter((a) => a.type === 'crosslink');

  console.log(label('Content:', chalk.bold(`${contentActions.length} page(s)`)));
  if (crosslinks.length) console.log(label('Crosslinks:', chalk.bold(`${crosslinks.length} (no generation needed)`)));

  const results = [];
  for (let i = 0; i < contentActions.length; i += CONCURRENCY) {
    const batch = contentActions.slice(i, i + CONCURRENCY);
    console.log(chalk.dim(`  Batch ${Math.floor(i / CONCURRENCY) + 1}: ${batch.map((a) => a.page_title || a.type).join(', ')}`));
    const batchStart = Date.now();

    const batchResults = await Promise.all(
      batch.map((action) => {
        const pageContent = loadPageContent(action.page_id, docsIndex, REPO_ROOT);
        return runWorker(action, pageContent, diff);
      })
    );

    const batchElapsed = Math.round((Date.now() - batchStart) / 1000);
    for (const r of batchResults) {
      const icon = r.skipped ? chalk.yellow('○') : chalk.green('✓');
      const status = r.skipped ? chalk.yellow(`skipped (${r.skip_reason})`) : r.summary;
      const mdLen = r.markdown ? `${Math.round(r.markdown.length / 1024)}KB` : '0KB';
      console.log(`    ${icon} ${r.page_title}: ${status} ${chalk.dim(`[${mdLen}]`)}`);
    }
    console.log(chalk.dim(`    Batch completed in ${batchElapsed}s`));
    results.push(...batchResults);
  }

  const elapsed = Math.round((Date.now() - phaseStart) / 1000);
  console.log(chalk.dim(`  Phase 2 completed in ${elapsed}s`));

  return { contentResults: results, crosslinks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const rootId = process.env.NOTION_TECHNICAL_ROOT_ID;
  if (!rootId) throw new Error('NOTION_TECHNICAL_ROOT_ID is required');

  const changedFiles = (process.env.CHANGED_FILES || '').split('\n').filter(Boolean);
  const diff = fs.readFileSync('/tmp/pr_diff.txt', 'utf8');

  console.log('');
  console.log(chalk.bold.cyan('TECHNICAL DOCS SYNC'));
  console.log(separator());
  console.log(label('Repository:', `${process.env.REPO_NAME} ${chalk.dim(`(${REPO_LABEL})`)}`));
  console.log(label('Trigger:   ', `${prRef()}: ${process.env.PR_TITLE}`));
  console.log(label('Author:    ', process.env.PR_AUTHOR));
  console.log(label('Changed:   ', `${changedFiles.length} files, ${Math.round(diff.length / 1024)}KB diff`));
  if (changedFiles.length <= 15) {
    for (const f of changedFiles) console.log(chalk.dim(`    ${f}`));
  } else {
    for (const f of changedFiles.slice(0, 10)) console.log(chalk.dim(`    ${f}`));
    console.log(chalk.dim(`    … and ${changedFiles.length - 10} more`));
  }
  console.log('');

  // Fetch docs using fetch-notion-docs.js
  console.log(chalk.cyan('Fetching documentation from Notion…'));
  execSync(`node ${path.join(SCRIPTS_DIR, 'fetch-notion-docs.js')}`, {
    cwd: SCRIPTS_DIR,
    env: { ...process.env, NOTION_TECHNICAL_ROOT_ID: rootId, REPO_ROOT },
    stdio: 'inherit',
  });

  const docsIndex = loadDocsIndex(DOCS_INDEX_PATH);
  console.log(`  ${chalk.bold(docsIndex.length)} pages fetched`);

  const docsOutline = buildDocsOutline(docsIndex, REPO_ROOT);
  console.log(chalk.dim(`  Docs outline: ${Math.round(docsOutline.length / 1024)}KB (headings only)`));

  // Phase 1: Assess
  console.log('');
  const plan = await assess(docsOutline, diff, docsIndex);

  if (!plan || !plan.meaningful || !plan.actions?.length) {
    console.log(chalk.dim('\nNo documentation updates needed.'));
    return;
  }

  // Validate page IDs
  const validIds = new Set(docsIndex.map((d) => d.id));
  validIds.add(rootId);

  const validActions = plan.actions.filter((action) => {
    const targetId = action.page_id || action.parent_id;
    if (targetId && !validIds.has(targetId)) {
      console.warn(chalk.yellow(`  ⚠ Skipping ${action.type} on "${action.page_title}": page_id ${targetId} not found in Notion tree`));
      return false;
    }
    return true;
  });

  if (!validActions.length) {
    console.log(chalk.dim('\nAll actions had invalid page IDs — nothing to do.'));
    return;
  }

  // Phase 2: Generate
  const { contentResults, crosslinks } = await generate(validActions, docsIndex, diff);

  // Phase 3: Write to Notion
  console.log('');
  console.log(chalk.cyan('Phase 3: Write to Notion'));
  const writeLog = writeResults({
    actions: validActions,
    results: contentResults,
    crosslinks,
    notionToolPath: NOTION_TOOL,
    metaFn: (type) => type === 'create' ? `Created: ${changeMeta()}` : `Rewritten: ${changeMeta()}`,
  });

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const succeeded = writeLog.filter((e) => e.status === 'ok').length;
  const failed = writeLog.filter((e) => e.status === 'error').length;
  const skipped = writeLog.filter((e) => e.status === 'skipped').length;

  console.log('');
  console.log(separator());
  console.log(chalk.bold('SYNC SUMMARY'));
  console.log(separator());
  console.log(label('Change:   ', `${prRef()}: ${process.env.PR_TITLE}`));
  console.log(label('Reasoning:', chalk.italic(plan.reasoning)));
  console.log(label('Actions:  ', [
    succeeded && chalk.green(`${succeeded} succeeded`),
    failed && chalk.red(`${failed} failed`),
    skipped && chalk.yellow(`${skipped} skipped`),
  ].filter(Boolean).join(', ')));
  console.log(label('Duration: ', `${elapsed}s`));
  console.log('');
  for (const entry of writeLog) {
    const icon = entry.status === 'ok' ? chalk.green('✓') : entry.status === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
    console.log(`  ${icon} ${chalk.bold((entry.type || '').padEnd(10))} "${entry.page}" ${chalk.dim(entry.id ? `[${entry.id}]` : '')}`);
    console.log(`    ${chalk.dim(entry.detail)}`);
  }
  console.log(separator());
}

main().catch((err) => {
  console.error(chalk.red.bold('Sync failed:'), err.message);
  process.exit(1);
});
