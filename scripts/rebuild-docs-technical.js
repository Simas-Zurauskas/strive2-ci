/**
 * rebuild-docs.js — Multi-agent documentation engine.
 *
 * Orchestrates parallel Claude agents to audit and rebuild Notion documentation:
 *   Phase A: Prepare — fetch docs, generate manifest, bundle docs
 *   Phase B: Plan   — orchestrator agent produces structured task plan
 *   Phase C: Execute — worker agents read source files & write markdown in parallel,
 *                      then sequential Notion write pass applies changes
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... NOTION_API_KEY=... NOTION_TECHNICAL_ROOT_ID=... node rebuild-docs.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-technical');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(SCRIPTS_DIR, '../..');
const DOCS_DIR = path.join(REPO_ROOT, '_docs');
const DOCS_INDEX_PATH = path.join(DOCS_DIR, '_index.json');
const NOTION_TOOL = path.join(SCRIPTS_DIR, 'notion-tool.js');

const CONCURRENCY = 5;
const WORKER_MAX_TURNS = 30;
const MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const label = (key, val) => `  ${chalk.bold(key)} ${val}`;
const separator = () => chalk.dim('─'.repeat(60));
const phaseHeader = (name) => chalk.bold.cyan(`\n${name}`);

// ---------------------------------------------------------------------------
// Phase A: Prepare
// ---------------------------------------------------------------------------

function generateManifest() {
  const run = (cmd) => execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  const files = run("find src -type f \\( -name '*.ts' -o -name '*.tsx' \\) | grep -v '_generated' | sort");
  const dirs = run('find src -type d -maxdepth 3 | sort');
  const barrels = run("find src -name 'index.ts' -o -name 'index.tsx' | sort");

  return [
    '# Codebase Manifest',
    '',
    '## All TypeScript/TSX files',
    '```',
    files,
    '```',
    '',
    '## Directory tree (depth 3)',
    '```',
    dirs,
    '```',
    '',
    '## Barrel files (index.ts)',
    '```',
    barrels,
    '```',
  ].join('\n');
}

function buildDocsBundle() {
  if (!fs.existsSync(DOCS_DIR)) return '';

  const mdFiles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) mdFiles.push(full);
    }
  }
  walk(DOCS_DIR);
  mdFiles.sort();

  const parts = [
    '# All Documentation Pages',
    '',
    'Each page is separated by <!-- SOURCE: path --> markers.',
    'Use _docs/_index.json for page IDs when writing back to Notion.',
    '',
  ];

  for (const f of mdFiles) {
    const rel = path.relative(REPO_ROOT, f);
    parts.push('---', '', `<!-- SOURCE: ${rel} -->`, '', fs.readFileSync(f, 'utf8'), '');
  }

  return parts.join('\n');
}

async function prepare() {
  const phaseStart = Date.now();
  console.log(phaseHeader('Phase A: Prepare'));
  console.log(label('Repo root:', chalk.dim(REPO_ROOT)));

  // 1. Fetch Notion docs
  console.log(chalk.cyan('\n  Fetching Notion documentation…'));
  execSync(`node ${path.join(SCRIPTS_DIR, 'fetch-notion-docs.js')}`, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });

  // 2. Generate manifest
  console.log(chalk.cyan('\n  Generating codebase manifest…'));
  const manifest = generateManifest();
  const fileCount = (manifest.match(/\.tsx?$/gm) || []).length;
  console.log(`  ${chalk.bold(fileCount)} source files, ${manifest.split('\n').length} manifest lines`);

  // 3. Read docs index
  let docsIndex = [];
  if (fs.existsSync(DOCS_INDEX_PATH)) {
    docsIndex = JSON.parse(fs.readFileSync(DOCS_INDEX_PATH, 'utf8'));
  }
  console.log(`\n  Docs index: ${chalk.bold(docsIndex.length)} pages`);
  for (const doc of docsIndex) {
    console.log(`    ${chalk.cyan(doc.title || doc.path)} ${chalk.dim(`[${doc.id}]`)}`);
  }

  // 4. Build docs bundle
  console.log(chalk.cyan('\n  Bundling documentation…'));
  const docsBundle = buildDocsBundle();
  console.log(`  Bundle: ${chalk.bold(`${Math.round(docsBundle.length / 1024)}KB`)}`);

  const phaseElapsed = Math.round((Date.now() - phaseStart) / 1000);
  console.log(chalk.dim(`\n  Phase A completed in ${phaseElapsed}s`));
  return { manifest, docsBundle, docsIndex };
}

// ---------------------------------------------------------------------------
// Phase B: Plan (orchestrator agent)
// ---------------------------------------------------------------------------

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    state: {
      type: 'string',
      enum: ['bootstrap', 'growth', 'maintenance'],
    },
    reasoning: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['rewrite', 'create', 'delete', 'rename', 'split'] },
          page_id: { type: 'string' },
          parent_id: { type: 'string' },
          title: { type: 'string' },
          section: { type: 'string' },
          current_doc_file: { type: 'string' },
          instructions: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'action', 'section', 'instructions', 'priority'],
      },
    },
  },
  required: ['state', 'reasoning', 'tasks'],
};

function buildOrchestratorPrompt(manifest, docsBundle, docsIndex) {
  return `You are a documentation planning agent for the Strive learning platform.

## Your job

Analyze the codebase file listing and existing documentation, then produce a structured
plan. Each task in your plan will be executed by an independent worker agent that has
access to the full codebase via Read, Glob, and Grep tools.

${DOC_STANDARDS.DOCUMENTATION_PHILOSOPHY}

## Determine the documentation state

- **bootstrap** — No or almost no documentation exists. Design the full page hierarchy.
- **growth** — Pages exist but the codebase has outgrown them. New areas need pages,
  large pages need splitting.
- **maintenance** — Pages exist and roughly match the code. Audit for accuracy and drift.

## Task planning rules

- Each task maps to ONE documentation page (one Notion write operation)
- Always use 'rewrite' for existing pages — never 'append'. Appending causes duplication
  and drift. Produce complete page content with changes integrated.
- For 'rewrite': include page_id from the docs index
- For 'create': include parent_id from the docs index (or the technical root ID)
- For 'delete': include page_id — only for pages documenting removed features
- For 'split': create separate child tasks (action: 'create') and one parent task
  (action: 'rewrite') that depends_on the children

## Instructions field

The instructions you write for each task are the worker agent's primary guidance.
Be specific about WHAT to document and WHAT to verify. The worker has Read, Glob,
and Grep tools and will explore the codebase itself to find the relevant files.
You do NOT need to specify file paths — the worker will discover them.

Good: "Document all custom hooks in src/hooks/. For each hook, cover its signature,
return type, dependencies, and usage patterns. Verify the useAuth hook's token
management against the actual NextAuth config."

Bad: "Update the hooks page."

${DOC_STANDARDS.PAGE_STRUCTURE}

## Inputs

### CODEBASE MANIFEST (all source files)
${manifest}

### CURRENT DOCUMENTATION
${docsBundle || '(No documentation exists — bootstrap mode)'}

### DOCS INDEX (Notion page IDs)
${JSON.stringify(docsIndex, null, 2)}

### TECHNICAL ROOT PAGE ID
${process.env.NOTION_TECHNICAL_ROOT_ID}

## Output

Produce your structured plan. Include clear instructions for each worker explaining
exactly what to document, what to verify, and what the page should cover.
Omit tasks for pages that are already accurate — only include work that needs doing.`;
}

async function orchestrate(manifest, docsBundle, docsIndex) {
  const phaseStart = Date.now();
  console.log(phaseHeader('Phase B: Plan'));
  console.log(chalk.cyan('  Running orchestrator agent…'));

  const prompt = buildOrchestratorPrompt(manifest, docsBundle, docsIndex);
  console.log(chalk.dim(`  Prompt: ${Math.round(prompt.length / 1024)}KB`));

  const conversation = query({
    prompt,
    options: {
      model: MODEL,
      maxTurns: 5,
      outputFormat: { type: 'json_schema', schema: PLAN_SCHEMA },
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: REPO_ROOT,
    },
  });

  let plan;
  for await (const event of conversation) {
    if (event.type === 'result' && event.subtype === 'success') {
      plan = event.structured_output || JSON.parse(event.result);
    }
  }

  if (!plan || !plan.tasks?.length) {
    console.log(chalk.dim('  Orchestrator produced no tasks — documentation is up to date.'));
    return { state: 'maintenance', reasoning: 'No changes needed', tasks: [] };
  }

  const stateColors = { bootstrap: chalk.magenta, growth: chalk.yellow, maintenance: chalk.green };
  const stateColor = stateColors[plan.state] || chalk.white;
  console.log(label('State:    ', stateColor(plan.state)));
  console.log(label('Reasoning:', chalk.italic(plan.reasoning)));
  console.log(label('Tasks:    ', chalk.bold(plan.tasks.length)));
  console.log('');
  for (const t of plan.tasks) {
    const priorityColor = t.priority === 1 ? chalk.red : t.priority === 2 ? chalk.yellow : chalk.dim;
    console.log(`    ${priorityColor(`P${t.priority}`)} ${chalk.bold(t.action.padEnd(8))} ${chalk.cyan(t.section)}${t.page_id ? chalk.dim(` [${t.page_id}]`) : ''}`);
    console.log(chalk.dim(`       ${t.instructions.slice(0, 120)}${t.instructions.length > 120 ? '…' : ''}`));
  }

  const phaseElapsed = Math.round((Date.now() - phaseStart) / 1000);
  console.log(chalk.dim(`\n  Phase B completed in ${phaseElapsed}s`));

  return plan;
}

// ---------------------------------------------------------------------------
// Phase C: Execute (workers + Notion writes)
// ---------------------------------------------------------------------------

const WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    action: { type: 'string' },
    markdown: { type: 'string' },
    page_id: { type: 'string' },
    parent_id: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    skipped: { type: 'boolean' },
    skip_reason: { type: 'string' },
  },
  required: ['task_id', 'action', 'markdown', 'summary', 'skipped'],
};

function buildWorkerPrompt(task, manifest) {
  let currentDoc = '';
  if (task.current_doc_file) {
    const docPath = path.join(REPO_ROOT, task.current_doc_file);
    if (fs.existsSync(docPath)) {
      currentDoc = fs.readFileSync(docPath, 'utf8');
    }
  }

  return `You are a documentation writer for the Strive learning platform.
You have ONE job: write complete, accurate documentation for a specific section.

## Your assignment

Section: ${task.section}
Action: ${task.action}
Task ID: ${task.id}

## Instructions from the planner

${task.instructions}

## Current documentation for this page

${currentDoc || '(No existing documentation — write from scratch)'}

## Codebase manifest (all files that exist)

${manifest}

## Process

1. Use the manifest above to identify which files are relevant to your section
2. Use Glob and Grep to find files, Read to examine them (batch 3-5 per turn)
3. Read every relevant file — do not guess or assume
4. Write complete documentation based on what you find in the code

${DOC_STANDARDS.WRITING_STANDARDS}

${DOC_STANDARDS.QUALITY_CRITERIA}

${DOC_STANDARDS.PAGE_STRUCTURE}

${DOC_STANDARDS.LINK_STANDARDS}

## Output

Your structured output must contain:
- task_id: "${task.id}"
- action: "${task.action}"
- markdown: the COMPLETE page content as markdown
- summary: one-line description of what you wrote
- skipped: false (unless the existing docs are already accurate, then true with skip_reason)
${task.page_id ? `- page_id: "${task.page_id}"` : ''}
${task.parent_id ? `- parent_id: "${task.parent_id}"` : ''}
${task.title ? `- title: "${task.title}"` : ''}`;
}

async function runWorkerAgent(task, manifest) {
  const prompt = buildWorkerPrompt(task, manifest);

  try {
    const conversation = query({
      prompt,
      options: {
        model: MODEL,
        maxTurns: WORKER_MAX_TURNS,
        outputFormat: { type: 'json_schema', schema: WORKER_OUTPUT_SCHEMA },
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        cwd: REPO_ROOT,
      },
    });

    let result;
    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        result = event.structured_output || JSON.parse(event.result);
      }
    }

    if (!result) {
      return {
        task_id: task.id,
        action: task.action,
        markdown: '',
        summary: 'Worker produced no output',
        skipped: true,
        skip_reason: 'No structured output returned',
      };
    }

    // Always use IDs from the plan — workers can't be trusted to echo them back
    result.page_id = task.page_id || result.page_id;
    result.parent_id = task.parent_id || result.parent_id;
    result.title = task.title || result.title;

    return result;
  } catch (err) {
    return {
      task_id: task.id,
      action: task.action,
      markdown: '',
      summary: `Worker error: ${err.message}`,
      skipped: true,
      skip_reason: err.message,
    };
  }
}

async function runTaskBatch(tasks, manifest) {
  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    console.log(chalk.cyan(`\n  Batch ${Math.floor(i / CONCURRENCY) + 1}: workers ${i + 1}–${i + batch.length} of ${tasks.length}`));
    const batchStart = Date.now();
    const batchResults = await Promise.all(batch.map((t) => runWorkerAgent(t, manifest)));
    const batchElapsed = Math.round((Date.now() - batchStart) / 1000);
    for (const r of batchResults) {
      const icon = r.skipped ? chalk.yellow('○') : chalk.green('✓');
      const status = r.skipped ? chalk.yellow(`skipped (${r.skip_reason})`) : `${r.action} — ${r.summary}`;
      const mdLen = r.markdown ? `${Math.round(r.markdown.length / 1024)}KB` : '0KB';
      console.log(`    ${icon} ${chalk.bold(r.task_id)}: ${status} ${chalk.dim(`[${mdLen}]`)}`);
    }
    console.log(chalk.dim(`    Batch completed in ${batchElapsed}s`));
    results.push(...batchResults);
  }
  return results;
}

function partitionTasks(tasks) {
  const independent = [];
  const dependent = [];
  for (const t of tasks) {
    if (t.depends_on && t.depends_on.length > 0) {
      dependent.push(t);
    } else {
      independent.push(t);
    }
  }
  // Sort by priority (1 = highest)
  independent.sort((a, b) => a.priority - b.priority);
  dependent.sort((a, b) => a.priority - b.priority);
  return { independent, dependent };
}

function resolveDependencies(dependentTasks, writeLog) {
  // Build map of task_id → created Notion page ID
  const createdIds = {};
  for (const entry of writeLog) {
    if (entry.created_id) {
      createdIds[entry.task_id] = entry.created_id;
    }
  }

  return dependentTasks.map((task) => {
    // Inject created page IDs into instructions
    const resolvedIds = (task.depends_on || [])
      .map((depId) => (createdIds[depId] ? `"${depId}" → page ID: ${createdIds[depId]}` : null))
      .filter(Boolean);

    if (resolvedIds.length > 0) {
      task.instructions += `\n\nChild pages created (reference these in the index):\n${resolvedIds.join('\n')}`;
    }

    return task;
  });
}

// ---------------------------------------------------------------------------
// Notion write pass
// ---------------------------------------------------------------------------

function writeToNotion(results) {
  const writeLog = [];

  for (const result of results) {
    if (result.skipped) {
      writeLog.push({ task_id: result.task_id, status: 'skipped', reason: result.skip_reason });
      console.log(`    ${chalk.yellow('○')} ${result.task_id}: ${chalk.yellow(`skipped — ${result.skip_reason}`)}`);
      continue;
    }

    if (!result.markdown || result.markdown.trim().length === 0) {
      writeLog.push({ task_id: result.task_id, status: 'skipped', reason: 'Empty markdown' });
      console.log(`    ${chalk.yellow('○')} ${result.task_id}: ${chalk.yellow('skipped — empty markdown')}`);
      continue;
    }

    // Write markdown to temp file
    const tmpFile = `/tmp/doc_${result.task_id.replace(/[^a-z0-9_-]/gi, '_')}.md`;
    fs.writeFileSync(tmpFile, result.markdown);

    const env = { ...process.env };
    const tool = `node ${NOTION_TOOL}`;

    try {
      let output;
      switch (result.action) {
        case 'rewrite':
          output = execSync(`${tool} rewrite ${result.page_id} ${tmpFile}`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'rewrite' });
          break;

        case 'append':
          output = execSync(`${tool} append ${result.page_id} ${tmpFile}`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'append' });
          break;

        case 'create': {
          if (!result.title || !result.parent_id) {
            writeLog.push({
              task_id: result.task_id,
              status: 'error',
              error: `Missing title ("${result.title}") or parent_id ("${result.parent_id}")`,
            });
            console.log(`    ${chalk.red('✗')} ${result.task_id}: ${chalk.red('create — missing title or parent_id')}`);
            continue;
          }
          const title = result.title.replace(/"/g, '\\"');
          output = execSync(`${tool} create ${result.parent_id} "${title}" ${tmpFile}`, { env, encoding: 'utf8' });
          const match = output.match(/\[([a-f0-9-]+)\]/);
          const createdId = match ? match[1] : null;
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'create', created_id: createdId });
          break;
        }

        case 'delete':
          output = execSync(`${tool} delete ${result.page_id}`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'delete' });
          break;

        case 'rename': {
          if (!result.title || !result.page_id) {
            writeLog.push({ task_id: result.task_id, status: 'error', error: `Missing title or page_id` });
            console.log(`    ${chalk.red('✗')} ${result.task_id}: ${chalk.red('rename — missing title or page_id')}`);
            continue;
          }
          const newTitle = result.title.replace(/"/g, '\\"');
          output = execSync(`${tool} rename ${result.page_id} "${newTitle}"`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'rename' });
          break;
        }

        default:
          writeLog.push({ task_id: result.task_id, status: 'skipped', reason: `Unknown action: ${result.action}` });
          continue;
      }

      console.log(`    ${chalk.green('✓')} ${chalk.bold(result.task_id)}: ${result.action} — ${result.summary}`);
    } catch (err) {
      writeLog.push({ task_id: result.task_id, status: 'error', error: err.message });
      console.log(`    ${chalk.red('✗')} ${chalk.bold(result.task_id)}: ${result.action} — ${chalk.red(err.message)}`);
    }
  }

  return writeLog;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(plan, allWriteResults, elapsed) {
  const succeeded = allWriteResults.filter((r) => r.status === 'success').length;
  const skipped = allWriteResults.filter((r) => r.status === 'skipped').length;
  const failed = allWriteResults.filter((r) => r.status === 'error').length;

  console.log('');
  console.log(separator());
  console.log(chalk.bold('REBUILD SUMMARY'));
  console.log(separator());

  const stateColors = { bootstrap: chalk.magenta, growth: chalk.yellow, maintenance: chalk.green };
  const stateColor = stateColors[plan.state] || chalk.white;
  console.log(label('State:    ', stateColor(plan.state)));
  console.log(label('Reasoning:', chalk.italic(plan.reasoning)));
  console.log(label('Tasks:    ', `${plan.tasks.length} planned`));
  console.log(label('Results:  ', [
    succeeded && chalk.green(`${succeeded} succeeded`),
    skipped && chalk.yellow(`${skipped} skipped`),
    failed && chalk.red(`${failed} failed`),
  ].filter(Boolean).join(', ')));
  console.log(label('Duration: ', `${elapsed}s`));
  if (failed > 0) {
    console.log('');
    console.log(chalk.red.bold('  Failures:'));
    for (const r of allWriteResults.filter((r) => r.status === 'error')) {
      console.log(`    ${chalk.red('✗')} ${r.task_id}: ${chalk.red(r.error)}`);
    }
  }
  console.log(separator());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log(chalk.bold.cyan('KNOWLEDGE BASE REBUILD'));
  console.log(separator());

  // Phase A
  const { manifest, docsBundle, docsIndex } = await prepare();

  // Phase B
  const plan = await orchestrate(manifest, docsBundle, docsIndex);

  if (plan.tasks.length === 0) {
    console.log(chalk.dim('\nNo tasks to execute. Documentation is up to date.'));
    return;
  }

  // Phase C
  const phaseCStart = Date.now();
  console.log(phaseHeader('Phase C: Execute'));
  const { independent, dependent } = partitionTasks(plan.tasks);

  console.log(label('Independent:', chalk.bold(independent.length)));
  console.log(label('Dependent:  ', chalk.bold(dependent.length)));

  // Run independent workers
  console.log(chalk.cyan('\n  --- Independent workers ---'));
  const independentResults = await runTaskBatch(independent, manifest);

  // Write independent results to Notion
  console.log(chalk.cyan('\n  --- Writing independent results to Notion ---'));
  const writeLog = writeToNotion(independentResults);

  // Run dependent workers (if any)
  let allWriteResults = [...writeLog];
  if (dependent.length > 0) {
    console.log(chalk.cyan('\n  --- Dependent workers ---'));
    const resolved = resolveDependencies(dependent, writeLog);
    const dependentResults = await runTaskBatch(resolved, manifest);

    console.log(chalk.cyan('\n  --- Writing dependent results to Notion ---'));
    const depWriteLog = writeToNotion(dependentResults);
    allWriteResults.push(...depWriteLog);
  }

  const phaseCElapsed = Math.round((Date.now() - phaseCStart) / 1000);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(chalk.dim(`\n  Phase C completed in ${phaseCElapsed}s`));
  printSummary(plan, allWriteResults, elapsed);
}

main().catch((err) => {
  console.error(chalk.red.bold('Rebuild failed:'), err.message);
  process.exit(1);
});
