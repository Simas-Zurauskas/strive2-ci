const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-product');

const SCRIPTS_DIR = __dirname;
const NOTION_TOOL = path.join(SCRIPTS_DIR, 'notion-tool.js');

const MODEL = 'claude-sonnet-4-6';
const CONCURRENCY = 3;
const REPO_LABEL = process.env.REPO_LABEL;

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const label = (key, val) => `  ${chalk.bold(key)} ${val}`;
const separator = () => chalk.dim('─'.repeat(60));

function prRef() {
  const num = process.env.PR_NUMBER;
  return num && num !== '0' ? `PR #${num}` : 'push';
}

function changeMeta() {
  return `${prRef()} by ${process.env.PR_AUTHOR} · ${new Date().toISOString().split('T')[0]}`;
}

// ---------------------------------------------------------------------------
// Phase 1: Assess
// ---------------------------------------------------------------------------

const ASSESS_SCHEMA = {
  type: 'object',
  properties: {
    meaningful: { type: 'boolean' },
    reasoning: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['rewrite', 'create'] },
          page_id: { type: 'string' },
          parent_id: { type: 'string' },
          page_title: { type: 'string' },
          instructions: { type: 'string' },
        },
        required: ['type', 'instructions'],
      },
    },
  },
  required: ['meaningful', 'reasoning', 'actions'],
};

function buildAssessPrompt(docsBundle, diff) {
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

The "How Strive Works" pages you can update (full current content of each page):
${docsBundle}

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
   Provide parent_id, page_title, and instructions.

CRITICAL RULES
- NEVER claim something is "not yet documented" unless you have carefully checked ALL
  existing page content above. You have the full content of every page — use it.
- STRONGLY prefer rewriting existing pages over creating new ones.
- Most changes should result in NO updates (set meaningful to false).

For each action, write detailed instructions explaining:
- What user-facing behavior changed
- Which sections of the page need updating
- What the content writer should emphasize (remember: NO code references in output)`;
}

async function assess(docsBundle, diff) {
  const phaseStart = Date.now();
  console.log(chalk.magenta('Phase 1: Assess'));

  const prompt = buildAssessPrompt(docsBundle, diff);
  console.log(chalk.dim(`  Prompt: ${Math.round(prompt.length / 1024)}KB`));

  const conversation = query({
    prompt,
    options: {
      model: MODEL,
      maxTurns: 1,
      outputFormat: { type: 'json_schema', schema: ASSESS_SCHEMA },
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  let plan;
  for await (const event of conversation) {
    if (event.type === 'result' && event.subtype === 'success') {
      plan = event.structured_output || JSON.parse(event.result);
    }
  }

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

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    page_title: { type: 'string' },
    markdown: { type: 'string' },
    summary: { type: 'string' },
    skipped: { type: 'boolean' },
    skip_reason: { type: 'string' },
  },
  required: ['page_title', 'markdown', 'summary', 'skipped'],
};

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
  const prompt = buildWorkerPrompt(action, pageContent, diff);

  try {
    const conversation = query({
      prompt,
      options: {
        model: MODEL,
        maxTurns: 1,
        outputFormat: { type: 'json_schema', schema: GENERATE_SCHEMA },
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });

    let result;
    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        result = event.structured_output || JSON.parse(event.result);
      }
    }

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
        let pageContent = '';
        if (action.page_id) {
          const indexEntry = docsIndex.find((d) => d.id === action.page_id);
          if (indexEntry?.file) {
            const filePath = path.resolve(SCRIPTS_DIR, '../..', indexEntry.file);
            if (fs.existsSync(filePath)) pageContent = fs.readFileSync(filePath, 'utf8');
          }
        }
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
// Phase 3: Write to Notion
// ---------------------------------------------------------------------------

function writeToNotion(actions, contentResults) {
  const writeLog = [];
  const tool = `node ${NOTION_TOOL}`;
  const env = { ...process.env };

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const result = contentResults[i];

    if (result.skipped) {
      writeLog.push({ status: 'skipped', type: action.type, page: action.page_title || action.type, detail: result.skip_reason });
      console.log(`    ${chalk.yellow('○')} ${action.page_title || action.type}: ${chalk.yellow(`skipped — ${result.skip_reason}`)}`);
      continue;
    }

    if (!result.markdown?.trim()) {
      writeLog.push({ status: 'skipped', type: action.type, page: action.page_title || action.type, detail: 'Empty markdown' });
      console.log(`    ${chalk.yellow('○')} ${action.page_title || action.type}: ${chalk.yellow('skipped — empty markdown')}`);
      continue;
    }

    const metaLine = action.type === 'create'
      ? `\n\n*Created: ${changeMeta()}*`
      : `\n\n*Rewritten: ${changeMeta()}*`;
    const markdown = result.markdown + metaLine;

    const tmpFile = `/tmp/sync_product_${action.type}_${(action.page_id || action.page_title || 'new').replace(/[^a-z0-9_-]/gi, '_')}.md`;
    fs.writeFileSync(tmpFile, markdown);

    try {
      switch (action.type) {
        case 'rewrite':
          execSync(`${tool} rewrite ${action.page_id} ${tmpFile}`, { env, encoding: 'utf8', stdio: 'pipe' });
          writeLog.push({ status: 'ok', type: 'rewrite', page: action.page_title, id: action.page_id, detail: `${result.markdown.length} chars` });
          break;
        case 'create': {
          const title = (action.page_title || result.page_title).replace(/"/g, '\\"');
          const output = execSync(`${tool} create ${action.parent_id} "${title}" ${tmpFile}`, { env, encoding: 'utf8', stdio: 'pipe' });
          const match = output.match(/\[([a-f0-9-]+)\]/);
          const createdId = match ? match[1] : null;
          writeLog.push({ status: 'ok', type: 'create', page: action.page_title, id: createdId, detail: `parent: ${action.parent_id}` });
          break;
        }
      }
      console.log(`    ${chalk.green('✓')} ${chalk.bold(action.type)} "${action.page_title}"`);
    } catch (err) {
      writeLog.push({ status: 'error', type: action.type, page: action.page_title, id: action.page_id || action.parent_id, detail: err.message });
      console.log(`    ${chalk.red('✗')} ${chalk.bold(action.type)} "${action.page_title}" — ${chalk.red(err.message)}`);
    }
  }

  return writeLog;
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

  // Fetch docs using fetch-notion-docs.js (proper markdown conversion)
  // Product pages have no skip list — all pages are fetched
  console.log(chalk.magenta('Fetching documentation from Notion…'));
  execSync(`node ${path.join(SCRIPTS_DIR, 'fetch-notion-docs.js')}`, {
    cwd: SCRIPTS_DIR,
    env: {
      ...process.env,
      NOTION_TECHNICAL_ROOT_ID: rootId,
      SKIP_TECHNICAL_PAGE_IDS: '',
      REPO_ROOT: path.resolve(SCRIPTS_DIR, '../..'),
    },
    stdio: 'inherit',
  });

  // Read fetched docs — move to product-specific dir to avoid collision with technical sync
  // fetch-notion-docs.js writes to _docs/, we copy the index for our use
  const defaultDocsDir = path.resolve(SCRIPTS_DIR, '../../_docs');
  let docsIndex = [];
  const defaultIndexPath = path.join(defaultDocsDir, '_index.json');
  if (fs.existsSync(defaultIndexPath)) {
    docsIndex = JSON.parse(fs.readFileSync(defaultIndexPath, 'utf8'));
  }
  console.log(`  ${chalk.bold(docsIndex.length)} pages fetched`);

  // Build docs bundle
  let docsBundle = '';
  for (const doc of docsIndex) {
    const filePath = path.resolve(SCRIPTS_DIR, '../..', doc.file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      docsBundle += `\n---\n\n- "${doc.title}" (${doc.path}) [${doc.id}]\n\n${content}\n`;
    }
  }
  console.log(chalk.dim(`  Docs bundle: ${Math.round(docsBundle.length / 1024)}KB`));

  // Phase 1: Assess
  console.log('');
  const plan = await assess(docsBundle, diff);

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
  const writeLog = writeToNotion(validActions, contentResults);

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
