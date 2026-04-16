/**
 * rebuild-docs.js — Multi-agent documentation engine.
 *
 * Orchestrates parallel Claude agents to audit and rebuild Notion documentation:
 *   Phase A: Prepare — fetch docs, generate manifest, build outline
 *   Phase B: Plan   — orchestrator agent produces structured task plan
 *   Phase C: Execute — worker agents read source files & write markdown in parallel,
 *                      then sequential Notion write pass applies changes
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... NOTION_API_KEY=... NOTION_ROOT_ID=... node rebuild-docs.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-technical');
const { indent, label, separator, phaseHeader, summaryHeader, phaseTiming } = require('./lib/log-helpers');
const { invokeAgent } = require('./lib/agent');
const { loadDocsIndex, buildDocsOutline } = require('./lib/docs');
const { PLAN_SCHEMA, WORKER_OUTPUT_SCHEMA } = require('./lib/schemas');


const SCRIPTS_DIR = __dirname;
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(SCRIPTS_DIR, '../..');
const DOCS_INDEX_PATH = path.join(REPO_ROOT, '_docs', '_index.json');
const NOTION_TOOL = path.join(SCRIPTS_DIR, 'notion-tool.js');

const CONCURRENCY = 5;
const WORKER_MAX_TURNS = 30;

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

async function prepare() {
  const phaseStart = Date.now();
  console.log(phaseHeader('Phase A: Prepare'));
  console.log(label('Repo root:', chalk.dim(REPO_ROOT)));

  // 1. Fetch Notion docs
  console.log(chalk.cyan(`\n${indent.L1}Fetching Notion documentation…`));
  execSync(`node ${path.join(SCRIPTS_DIR, 'fetch-notion-docs.js')}`, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });

  // 2. Generate manifest
  console.log(chalk.cyan(`\n${indent.L1}Generating codebase manifest…`));
  const manifest = generateManifest();
  const fileCount = (manifest.match(/\.tsx?$/gm) || []).length;
  console.log(`${indent.L1}${chalk.bold(fileCount)} source files, ${manifest.split('\n').length} manifest lines`);

  // 3. Read docs index
  const docsIndex = loadDocsIndex(DOCS_INDEX_PATH);
  console.log(`\n${indent.L1}Docs index: ${chalk.bold(docsIndex.length)} pages`);
  for (const doc of docsIndex) {
    console.log(`${indent.L2}${chalk.cyan(doc.title || doc.path)} ${chalk.dim(`[${doc.id}]`)}`);
  }

  // 4. Build docs outline (headings only — for orchestrator)
  console.log(chalk.cyan(`\n${indent.L1}Building documentation outline…`));
  const docsOutline = buildDocsOutline(docsIndex, REPO_ROOT);
  console.log(`${indent.L1}Outline: ${chalk.bold(`${Math.round(docsOutline.length / 1024)}KB`)} (headings only)`);

  console.log(phaseTiming('Phase A', Date.now() - phaseStart));
  return { manifest, docsOutline, docsIndex };
}

// ---------------------------------------------------------------------------
// Phase B: Plan (orchestrator agent)
// ---------------------------------------------------------------------------

function buildOrchestratorPrompt(manifest, docsOutline, docsIndex) {
  return `You are a documentation planning agent for the Strive learning platform.

## Your job

Analyze the codebase file listing and existing documentation outline, then produce a
structured plan. Each task in your plan will be executed by an independent worker agent
that has access to the full codebase via Read, Glob, and Grep tools.

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
- For 'rewrite': include page_id and current_doc_file from the docs index
- For 'create': MUST include parent_id and title. Use the page ID of the parent page
  from the docs index — NOT the technical root ID. Sub-pages go under their parent.
  For example, an "Architecture" page about the API should have the API page's ID as
  parent_id. Only use the technical root ID for genuinely top-level pages.
- For 'delete': include page_id — only for pages documenting removed features
- For 'split': create separate child tasks (action: 'create') and one parent task
  (action: 'rewrite') that depends_on the children

## Coverage check

After drafting your task list, verify that every major subsystem in the codebase has
corresponding documentation. Cross-reference the codebase manifest against the existing
docs outline. If a significant feature area (authentication, course creation, lesson
generation, quizzes, gamification, etc.) has no page or section, plan a task for it.

## Instructions field

The instructions you write for each task are the worker agent's primary guidance.
Be specific about WHAT to document and WHAT to verify. The worker has Read, Glob,
and Grep tools and will explore the codebase itself to find the relevant files.
You do NOT need to specify file paths — the worker will discover them.

Include specific verification instructions: "Verify the exact count of endpoints by
reading the route file. Check for conditional behavior in the delete-account flow.
Confirm the mastery tier thresholds against the constants file."

Good: "Document all custom hooks in src/hooks/. For each hook, cover its signature,
return type, dependencies, and usage patterns. Verify the useAuth hook's token
management against the actual NextAuth config."

Bad: "Update the hooks page."

${DOC_STANDARDS.PAGE_STRUCTURE}

## Inputs

### CODEBASE MANIFEST (all source files)
${manifest}

### CURRENT DOCUMENTATION OUTLINE (section headings per page)
Below are the section headings for each existing documentation page. This shows you
what topics are already covered. Workers will receive the full page content when rewriting.
${docsOutline}

### DOCS INDEX (Notion page IDs and file paths)
${JSON.stringify(docsIndex, null, 2)}

### TECHNICAL ROOT PAGE ID
${process.env.NOTION_ROOT_ID}

## Output

Produce your structured plan. Include clear instructions for each worker explaining
exactly what to document, what to verify, and what the page should cover.
Omit tasks for pages that are already accurate — only include work that needs doing.`;
}

async function orchestrate(manifest, docsOutline, docsIndex) {
  const phaseStart = Date.now();
  console.log(phaseHeader('Phase B: Plan'));

  const prompt = buildOrchestratorPrompt(manifest, docsOutline, docsIndex);
  console.log(chalk.dim(`${indent.L1}Prompt: ${Math.round(prompt.length / 1024)}KB`));

  const plan = await invokeAgent({ prompt, schema: PLAN_SCHEMA, maxTurns: 10, cwd: REPO_ROOT, label: 'Orchestrator' });

  if (!plan || !plan.tasks?.length) {
    console.log(chalk.dim(`${indent.L1}Orchestrator produced no tasks — documentation is up to date.`));
    console.log(phaseTiming('Phase B', Date.now() - phaseStart));
    return { state: 'maintenance', reasoning: 'No changes needed', tasks: [] };
  }

  // Validate create tasks have parent_id
  for (const t of plan.tasks) {
    if (t.action === 'create' && !t.parent_id) {
      console.warn(chalk.yellow(`${indent.L1}${'⚠'} Task "${t.id}" is a create but has no parent_id — will fail at write time`));
    }
  }

  const stateColors = { bootstrap: chalk.magenta, growth: chalk.yellow, maintenance: chalk.green };
  const stateColor = stateColors[plan.state] || chalk.white;
  console.log(label('State:    ', stateColor(plan.state)));
  console.log(label('Reasoning:', chalk.italic(plan.reasoning)));
  console.log(label('Tasks:    ', chalk.bold(plan.tasks.length)));
  console.log('');
  for (const t of plan.tasks) {
    const priorityColor = t.priority === 1 ? chalk.red : t.priority === 2 ? chalk.yellow : chalk.dim;
    const idInfo = t.page_id ? ` [${t.page_id}]` : t.parent_id ? ` → parent [${t.parent_id}]` : '';
    console.log(`${indent.L2}${priorityColor(`P${t.priority}`)} ${chalk.bold(t.action.padEnd(8))} ${chalk.cyan(t.section)}${t.title ? ` "${t.title}"` : ''}${chalk.dim(idInfo)}`);
    console.log(chalk.dim(`${indent.L3}${t.instructions.slice(0, 120)}${t.instructions.length > 120 ? '…' : ''}`));
  }

  console.log(phaseTiming('Phase B', Date.now() - phaseStart));

  return plan;
}

// ---------------------------------------------------------------------------
// Phase C: Execute (workers + Notion writes)
// ---------------------------------------------------------------------------

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

${DOC_STANDARDS.VERIFICATION_RULES}

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
    const result = await invokeAgent({
      prompt,
      schema: WORKER_OUTPUT_SCHEMA,
      maxTurns: WORKER_MAX_TURNS,
      tools: ['Read', 'Glob', 'Grep'],
      cwd: REPO_ROOT,
      label: `Worker: ${task.section}`,
    });

    if (!result) {
      return {
        task_id: task.id, action: task.action, markdown: '', summary: 'Worker produced no output',
        skipped: true, skip_reason: 'No structured output returned',
      };
    }

    // Always use IDs from the plan — workers can't be trusted to echo them back
    result.page_id = task.page_id || result.page_id;
    result.parent_id = task.parent_id || result.parent_id;
    result.title = task.title || result.title;

    return result;
  } catch (err) {
    return {
      task_id: task.id, action: task.action, markdown: '', summary: `Worker error: ${err.message}`,
      skipped: true, skip_reason: err.message,
    };
  }
}

async function runTaskBatch(tasks, manifest) {
  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    console.log(chalk.cyan(`\n${indent.L1}Batch ${Math.floor(i / CONCURRENCY) + 1}: workers ${i + 1}–${i + batch.length} of ${tasks.length}`));
    const batchStart = Date.now();
    const batchResults = await Promise.all(batch.map((t) => runWorkerAgent(t, manifest)));
    const batchElapsed = Math.round((Date.now() - batchStart) / 1000);
    for (const r of batchResults) {
      const icon = r.skipped ? chalk.yellow('○') : chalk.green('✓');
      const status = r.skipped ? chalk.yellow(`skipped (${r.skip_reason})`) : `${r.action} — ${r.summary}`;
      const mdLen = r.markdown ? `${Math.round(r.markdown.length / 1024)}KB` : '0KB';
      console.log(`${indent.L2}${icon} ${chalk.bold(r.task_id)}: ${status} ${chalk.dim(`[${mdLen}]`)}`);
    }
    console.log(chalk.dim(`${indent.L2}Batch completed in ${batchElapsed}s`));
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
  independent.sort((a, b) => a.priority - b.priority);
  dependent.sort((a, b) => a.priority - b.priority);
  return { independent, dependent };
}

function resolveDependencies(dependentTasks, writeLog) {
  const createdIds = {};
  for (const entry of writeLog) {
    if (entry.created_id) {
      createdIds[entry.task_id] = entry.created_id;
    }
  }

  return dependentTasks.map((task) => {
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
// Notion write pass (rebuild-specific: task-based, supports delete/rename)
// ---------------------------------------------------------------------------

function writeToNotion(results) {
  const writeLog = [];
  const tool = `node ${NOTION_TOOL}`;
  const env = { ...process.env };

  for (const result of results) {
    if (result.skipped) {
      writeLog.push({ task_id: result.task_id, status: 'skipped', reason: result.skip_reason });
      console.log(`${indent.L2}${chalk.yellow('○')} ${result.task_id}: ${chalk.yellow(`skipped — ${result.skip_reason}`)}`);
      continue;
    }

    if (!result.markdown || result.markdown.trim().length === 0) {
      writeLog.push({ task_id: result.task_id, status: 'skipped', reason: 'Empty markdown' });
      console.log(`${indent.L2}${chalk.yellow('○')} ${result.task_id}: ${chalk.yellow('skipped — empty markdown')}`);
      continue;
    }

    const tmpFile = `/tmp/doc_${result.task_id.replace(/[^a-z0-9_-]/gi, '_')}.md`;
    fs.writeFileSync(tmpFile, result.markdown);

    try {
      let output;
      switch (result.action) {
        case 'rewrite':
          output = execSync(`${tool} rewrite ${result.page_id} ${tmpFile}`, { env, encoding: 'utf8' });
          writeLog.push({ task_id: result.task_id, status: 'success', action: 'rewrite' });
          break;

        case 'create': {
          if (!result.title || !result.parent_id) {
            writeLog.push({ task_id: result.task_id, status: 'error', error: `Missing title ("${result.title}") or parent_id ("${result.parent_id}")` });
            console.log(`${indent.L2}${chalk.red('✗')} ${result.task_id}: ${chalk.red('create — missing title or parent_id')}`);
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
            writeLog.push({ task_id: result.task_id, status: 'error', error: 'Missing title or page_id' });
            console.log(`${indent.L2}${chalk.red('✗')} ${result.task_id}: ${chalk.red('rename — missing title or page_id')}`);
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

      console.log(`${indent.L2}${chalk.green('✓')} ${chalk.bold(result.task_id)}: ${result.action} — ${result.summary}`);
    } catch (err) {
      writeLog.push({ task_id: result.task_id, status: 'error', error: err.message });
      console.log(`${indent.L2}${chalk.red('✗')} ${chalk.bold(result.task_id)}: ${result.action} — ${chalk.red(err.message)}`);
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

  console.log(summaryHeader('REBUILD SUMMARY'));

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
    console.log(chalk.red.bold(`${indent.L1}Failures:`));
    for (const r of allWriteResults.filter((r) => r.status === 'error')) {
      console.log(`${indent.L2}${chalk.red('✗')} ${r.task_id}: ${chalk.red(r.error)}`);
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
  const { manifest, docsOutline, docsIndex } = await prepare();

  // Phase B
  const plan = await orchestrate(manifest, docsOutline, docsIndex);

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
  console.log(chalk.cyan(`\n${indent.L1}--- Independent workers ---`));
  const independentResults = await runTaskBatch(independent, manifest);

  // Write independent results to Notion
  console.log(chalk.cyan(`\n${indent.L1}--- Writing independent results to Notion ---`));
  const writeLog = writeToNotion(independentResults);

  // Run dependent workers (if any)
  let allWriteResults = [...writeLog];
  if (dependent.length > 0) {
    console.log(chalk.cyan(`\n${indent.L1}--- Dependent workers ---`));
    const resolved = resolveDependencies(dependent, writeLog);
    const dependentResults = await runTaskBatch(resolved, manifest);

    console.log(chalk.cyan(`\n${indent.L1}--- Writing dependent results to Notion ---`));
    const depWriteLog = writeToNotion(dependentResults);
    allWriteResults.push(...depWriteLog);
  }

  console.log(phaseTiming('Phase C', Date.now() - phaseCStart));

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  printSummary(plan, allWriteResults, elapsed);
}

main().catch((err) => {
  console.error(chalk.red.bold('Rebuild failed:'), err.message);
  process.exit(1);
});
