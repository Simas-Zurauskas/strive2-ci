const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-technical');

const SCRIPTS_DIR = __dirname;
const DOCS_DIR = path.resolve(SCRIPTS_DIR, '../../_docs');
const DOCS_INDEX_PATH = path.join(DOCS_DIR, '_index.json');
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
          type: { type: 'string', enum: ['rewrite', 'create', 'crosslink'] },
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
  const rootId = process.env.NOTION_TECHNICAL_ROOT_ID;

  return `You are a living documentation agent for this project.
You are operating in the **${REPO_LABEL}** repository.

${DOC_STANDARDS.DOCUMENTATION_PHILOSOPHY}

${DOC_STANDARDS.UPDATE_RULES}

DOCUMENTATION STRUCTURE
All documentation lives in Notion under two top-level sections:
- **Product** — manually curated vision, features, and strategy docs. NEVER modify these.
- **Technical** — architecture, conventions, and implementation docs. This is your scope.

The Technical section you can update (full current content of each page):
${docsBundle}

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
   Provide parent_id, page_title, and instructions.

3. **crosslink** — Add a cross-reference note to a page when a change in this repo
   has implications for documentation in another section. Provide page_id and instructions
   describing the note to add.

CRITICAL RULES
- NEVER claim something is "not yet documented" unless you have carefully checked ALL
  existing page content above. You have the full content of every page — use it.
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

async function assess(docsBundle, diff) {
  const phaseStart = Date.now();
  console.log(chalk.cyan('Phase 1: Assess'));

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
      console.log(`    ${chalk.bold(a.type.padEnd(10))} ${chalk.cyan(a.page_title || a.page_id || '(new)')}`);
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
  console.log(chalk.cyan('Phase 2: Generate'));

  // Filter out crosslinks (they don't need content generation)
  const contentActions = actions.filter((a) => a.type !== 'crosslink');
  const crosslinks = actions.filter((a) => a.type === 'crosslink');

  console.log(label('Content:', chalk.bold(`${contentActions.length} page(s)`)));
  if (crosslinks.length) console.log(label('Crosslinks:', chalk.bold(`${crosslinks.length} (no generation needed)`)));

  // Load current page content for each action
  const results = [];
  for (let i = 0; i < contentActions.length; i += CONCURRENCY) {
    const batch = contentActions.slice(i, i + CONCURRENCY);
    console.log(chalk.dim(`  Batch ${Math.floor(i / CONCURRENCY) + 1}: ${batch.map((a) => a.page_title || a.type).join(', ')}`));
    const batchStart = Date.now();

    const batchResults = await Promise.all(
      batch.map((action) => {
        // Find current page content from _docs
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

  return { contentResults: results, crosslinks };
}

// ---------------------------------------------------------------------------
// Phase 3: Write to Notion
// ---------------------------------------------------------------------------

function writeToNotion(actions, contentResults, crosslinks) {
  const writeLog = [];
  const tool = `node ${NOTION_TOOL}`;
  const env = { ...process.env };

  // Write content results (rewrite/create)
  for (let i = 0; i < actions.filter((a) => a.type !== 'crosslink').length; i++) {
    const action = actions.filter((a) => a.type !== 'crosslink')[i];
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

    // Add change metadata footer
    const metaLine = action.type === 'create'
      ? `\n\n*Created: ${changeMeta()}*`
      : `\n\n*Rewritten: ${changeMeta()}*`;
    const markdown = result.markdown + metaLine;

    const tmpFile = `/tmp/sync_${action.type}_${(action.page_id || action.page_title || 'new').replace(/[^a-z0-9_-]/gi, '_')}.md`;
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

  // Write crosslinks
  for (const action of crosslinks) {
    const note = `Cross-repo update (${prRef()}): ${action.instructions}`;
    const crosslinkMd = `---\n\n> 🔗 ${note}\n\n*${changeMeta()}*`;
    const tmpFile = `/tmp/sync_crosslink_${(action.page_id || '').replace(/[^a-z0-9_-]/gi, '_')}.md`;
    fs.writeFileSync(tmpFile, crosslinkMd);

    try {
      execSync(`${tool} append ${action.page_id} ${tmpFile}`, { env, encoding: 'utf8', stdio: 'pipe' });
      writeLog.push({ status: 'ok', type: 'crosslink', page: action.page_title, id: action.page_id, detail: action.instructions.slice(0, 120) });
      console.log(`    ${chalk.green('✓')} ${chalk.bold('crosslink')} "${action.page_title}"`);
    } catch (err) {
      writeLog.push({ status: 'error', type: 'crosslink', page: action.page_title, id: action.page_id, detail: err.message });
      console.log(`    ${chalk.red('✗')} ${chalk.bold('crosslink')} "${action.page_title}" — ${chalk.red(err.message)}`);
    }
  }

  return writeLog;
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

  // Fetch docs using fetch-notion-docs.js (proper markdown conversion + page exclusion)
  console.log(chalk.cyan('Fetching documentation from Notion…'));
  execSync(`node ${path.join(SCRIPTS_DIR, 'fetch-notion-docs.js')}`, {
    cwd: SCRIPTS_DIR,
    env: {
      ...process.env,
      NOTION_TECHNICAL_ROOT_ID: rootId,
      REPO_ROOT: path.resolve(SCRIPTS_DIR, '../..'),
    },
    stdio: 'inherit',
  });

  // Read fetched docs
  let docsIndex = [];
  if (fs.existsSync(DOCS_INDEX_PATH)) {
    docsIndex = JSON.parse(fs.readFileSync(DOCS_INDEX_PATH, 'utf8'));
  }
  console.log(`  ${chalk.bold(docsIndex.length)} pages fetched`);

  // Build docs bundle (same format as rebuild)
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
    console.log(chalk.dim('\nNo documentation updates needed.'));
    return;
  }

  // Validate page IDs against fetched tree
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
  const writeLog = writeToNotion(validActions, contentResults, crosslinks);

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
