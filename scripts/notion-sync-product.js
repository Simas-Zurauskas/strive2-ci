const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-product');
const { label, separator, prRef, changeMeta } = require('./lib/log-helpers');
const { invokeAgent } = require('./lib/agent');
const { loadDocsIndex, buildDocsOutline, loadPageContent } = require('./lib/docs');
const { assessSchema, GENERATE_SCHEMA } = require('./lib/schemas');
const { writeResults } = require('./lib/notion-writer');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../..');
const NOTION_TOOL = path.join(SCRIPTS_DIR, 'notion-tool.js');
const CONCURRENCY = 3;
const REPO_LABEL = process.env.REPO_LABEL;

const ASSESS_SCHEMA = assessSchema(['rewrite', 'create']);

// ---------------------------------------------------------------------------
// Phase 1: Assess
// ---------------------------------------------------------------------------

function buildAssessPrompt(docsOutline, diff) {
  const rootId = process.env.NOTION_PRODUCT_ROOT_ID;

  return `You are a product documentation agent for Strive, an AI-powered learning platform.
You are operating in the **${REPO_LABEL}** repository.

${DOC_STANDARDS.DOCUMENTATION_PHILOSOPHY}

${DOC_STANDARDS.UPDATE_RULES}

DOCUMENTATION STRUCTURE
You manage the "How Strive Works" section — product-level documentation that explains
what the platform does, how features work, and the business logic behind them.
These pages are read by everyone: developers, product managers, and leadership.

CRITICAL: Documentation must contain ZERO code references. No file paths, no function
names, no API endpoints, no schema fields, no inline code backticks. Describe everything
in plain language.

The "How Strive Works" pages you can update (section headings per page — shows what topics are covered):
${docsOutline}

Root page ID: ${rootId}

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

Assess whether this change requires product documentation updates. You are ONLY producing
a plan — do NOT write any page content. A separate agent will handle content generation
based on your instructions.

ASSESSMENT CRITERIA
Only update product docs when a change affects:
- What a user sees or experiences (new UI, changed flow, new content type)
- How a feature works (new business rule, changed behavior, new capability)
- Business logic (scoring changes, scheduling changes, new gating rules)
- System relationships (new feature that connects to existing ones)

Do NOT update for:
- Internal refactors that don't change behavior
- Performance optimizations
- Dependency updates
- Code cleanup, middleware changes, schema field renames
- Bug fixes (unless they change documented behavior)

ACTIONS

1. **rewrite** — PREFERRED. Flag an existing page for a full rewrite. Provide page_id
   and clear instructions for the content writer about what user-facing behavior changed
   and how to integrate it into the existing page.

2. **create** — RARELY used. Create a new page ONLY when the change introduces a major,
   entirely new feature area that genuinely has no home in ANY existing page. Individual
   behaviors, sub-features, or enhancements should be documented as sections within
   existing pages (via rewrite), NOT as separate pages. When in doubt, rewrite.
   MUST provide parent_id (the page ID of the parent page, NOT the root), page_title,
   and instructions. Sub-pages go under their parent.

CRITICAL RULES
- NEVER claim something is "not yet documented" unless you have carefully checked ALL
  existing page headings above.
- STRONGLY prefer rewriting existing pages over creating new ones.
- Most changes should result in NO updates (set meaningful to false).

For each action, write detailed instructions explaining:
- What user-facing behavior changed
- Which sections of the page need updating
- What the content writer should emphasize (remember: NO code references in output)`;
}

async function assess(docsOutline, diff) {
  const phaseStart = Date.now();
  console.log(chalk.magenta('Phase 1: Assess'));

  const prompt = buildAssessPrompt(docsOutline, diff);
  console.log(chalk.dim(`  Prompt: ${Math.round(prompt.length / 1024)}KB`));

  const plan = await invokeAgent({ prompt, schema: ASSESS_SCHEMA, maxTurns: 3 });
  const elapsed = Math.round((Date.now() - phaseStart) / 1000);

  if (!plan) {
    console.log(chalk.yellow(`  No response from assessor ${chalk.dim(`(${elapsed}s)`)}`));
    return null;
  }

  console.log(`  Meaningful: ${plan.meaningful ? chalk.green('yes') : chalk.yellow('no')} ${chalk.dim(`(${elapsed}s)`)}`);
  console.log(`  Reasoning:  ${chalk.italic(plan.reasoning)}`);

  if (plan.meaningful && plan.actions?.length) {
    for (const a of plan.actions) {
      console.log(`    ${chalk.bold(a.type.padEnd(10))} ${chalk.magenta(a.page_title || a.page_id || '(new)')}`);
      console.log(chalk.dim(`       ${a.instructions.slice(0, 120)}${a.instructions.length > 120 ? '…' : ''}`));
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Phase 2: Generate (per-page workers)
// ---------------------------------------------------------------------------

function buildWorkerPrompt(action, pageContent, diff) {
  return `You are a product documentation writer for Strive, an AI-powered learning platform.
You have ONE job: write complete, accurate product documentation for a specific page.

## Your assignment

Page: ${action.page_title || '(new page)'}
Action: ${action.type}

## Instructions from the planner

${action.instructions}

## Current page content

${pageContent || '(No existing documentation — write from scratch)'}

## Code diff that triggered this update

${diff}

CRITICAL — NO CODE REFERENCES:
- Never mention file paths, function names, class names, or variable names
- Never mention API endpoints or HTTP methods
- Never mention schema field names, database collections, or model names
- Never use inline code backticks for technical identifiers
- Describe what happens in plain language

${DOC_STANDARDS.WRITING_STANDARDS}

${DOC_STANDARDS.QUALITY_CRITERIA}

${DOC_STANDARDS.PAGE_STRUCTURE}

${DOC_STANDARDS.LINK_STANDARDS}

## Output

Write the COMPLETE page content as markdown. This will fully replace the existing page,
so include ALL content — both updated sections and unchanged sections.
Do not omit existing content that is still accurate.
Remember: ZERO code references anywhere in the output.

If after reviewing the diff and current content you determine no update is actually needed,
set skipped to true with a skip_reason.`;
}

async function runWorker(action, pageContent, diff) {
  try {
    const prompt = buildWorkerPrompt(action, pageContent, diff);
    const result = await invokeAgent({ prompt, schema: GENERATE_SCHEMA, maxTurns: 3 });
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
  console.log(chalk.magenta('Phase 2: Generate'));
  console.log(label('Content:', chalk.bold(`${actions.length} page(s)`)));

  const results = [];
  for (let i = 0; i < actions.length; i += CONCURRENCY) {
    const batch = actions.slice(i, i + CONCURRENCY);
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

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const rootId = process.env.NOTION_PRODUCT_ROOT_ID;
  if (!rootId) throw new Error('NOTION_PRODUCT_ROOT_ID is required');

  const changedFiles = (process.env.CHANGED_FILES || '').split('\n').filter(Boolean);
  const diff = fs.readFileSync('/tmp/pr_diff.txt', 'utf8');

  console.log('');
  console.log(chalk.bold.magenta('PRODUCT DOCS SYNC'));
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
  console.log(chalk.magenta('Fetching documentation from Notion…'));
  execSync(`node ${path.join(SCRIPTS_DIR, 'fetch-notion-docs.js')}`, {
    cwd: SCRIPTS_DIR,
    env: { ...process.env, NOTION_TECHNICAL_ROOT_ID: rootId, SKIP_PAGE_IDS: '', REPO_ROOT },
    stdio: 'inherit',
  });

  const defaultIndexPath = path.join(REPO_ROOT, '_docs', '_index.json');
  const docsIndex = loadDocsIndex(defaultIndexPath);
  console.log(`  ${chalk.bold(docsIndex.length)} pages fetched`);

  const docsOutline = buildDocsOutline(docsIndex, REPO_ROOT);
  console.log(chalk.dim(`  Docs outline: ${Math.round(docsOutline.length / 1024)}KB (headings only)`));

  // Phase 1: Assess
  console.log('');
  const plan = await assess(docsOutline, diff);

  if (!plan || !plan.meaningful || !plan.actions?.length) {
    console.log(chalk.dim('\nNo product documentation updates needed.'));
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
  const contentResults = await generate(validActions, docsIndex, diff);

  // Phase 3: Write to Notion
  console.log('');
  console.log(chalk.magenta('Phase 3: Write to Notion'));
  const writeLog = writeResults({
    actions: validActions,
    results: contentResults,
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
  console.log(chalk.bold('PRODUCT SYNC SUMMARY'));
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
  console.error(chalk.red.bold('Product sync failed:'), err.message);
  process.exit(1);
});
