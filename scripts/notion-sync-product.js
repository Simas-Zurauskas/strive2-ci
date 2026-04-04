const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
const { markdownToBlocks } = require('@tryfabric/martian');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards-product');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DELAY_MS = 350; // stay under Notion's 3 req/s limit

function sanitizeMarkdownLinks(markdown) {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (/^https?:\/\//i.test(url)) return match;
    return text; // For product docs: just use the plain text, no backticks
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO_LABEL = process.env.REPO_LABEL;

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const label = (key, val) => `  ${chalk.bold(key)} ${val}`;
const separator = () => chalk.dim('─'.repeat(60));

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

async function fetchPageTree(blockId, path = '') {
  const pages = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of res.results) {
      if (block.type === 'child_page') {
        const title = block.child_page.title;
        const fullPath = path ? `${path} > ${title}` : title;
        pages.push({ id: block.id, title, path: fullPath });
        const children = await fetchPageTree(block.id, fullPath);
        pages.push(...children);
      }
    }
    cursor = res.next_cursor;
  } while (cursor);
  return pages;
}

function richTextToPlain(richTexts) {
  if (!richTexts) return '';
  return richTexts.map((rt) => rt.plain_text || '').join('');
}

function blockToText(block) {
  if (block.type === 'child_page' || block.type === 'child_database') return '';
  const data = block[block.type];
  if (!data) return '';
  switch (block.type) {
    case 'paragraph':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'to_do':
    case 'toggle':
    case 'quote':
    case 'callout':
      return richTextToPlain(data.rich_text);
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      return richTextToPlain(data.rich_text);
    case 'code':
      return richTextToPlain(data.rich_text);
    default:
      return '';
  }
}

async function fetchPageSummary(pageId, maxChars = 1500) {
  let text = '';
  let cursor;
  do {
    await sleep(DELAY_MS);
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 50,
    });
    for (const block of res.results) {
      const line = blockToText(block);
      if (line) text += line + '\n';
      if (text.length >= maxChars) return text.slice(0, maxChars) + '…';
    }
    cursor = res.next_cursor;
  } while (cursor);
  return text.trim();
}

const RICH_TEXT_LIMIT = 2000;

function splitRichText(rt) {
  if (!rt.text?.content) return [rt];
  const text = rt.text.content;
  if (text.length <= RICH_TEXT_LIMIT) return [rt];
  const chunks = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_LIMIT) {
    chunks.push({ ...rt, text: { ...rt.text, content: text.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return chunks;
}

function enforceRichTextLimits(blocks) {
  for (const block of blocks) {
    const inner = block[block.type];
    if (inner?.rich_text) {
      inner.rich_text = inner.rich_text.flatMap(splitRichText);
    }
  }
  return blocks;
}

function metaBlock(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: text }, annotations: { color: 'gray', italic: true } }],
    },
  };
}

function prRef() {
  const num = process.env.PR_NUMBER;
  return num && num !== '0' ? `PR #${num}` : 'push';
}

function changeMeta() {
  return `${prRef()} by ${process.env.PR_AUTHOR} · ${new Date().toISOString().split('T')[0]}`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function rewritePage(pageId, content) {
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
    for (const block of res.results) {
      try {
        await notion.blocks.delete({ block_id: block.id });
      } catch (_) {
        // Some blocks (e.g. child_page) can't be deleted — skip them
      }
    }
    cursor = res.next_cursor;
  } while (cursor);

  const children = enforceRichTextLimits(markdownToBlocks(sanitizeMarkdownLinks(content)));
  children.push(metaBlock(`Rewritten: ${changeMeta()}`));

  for (let i = 0; i < children.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + 100),
    });
  }
}

async function createPage(parentId, title, content, linksTo = []) {
  const children = enforceRichTextLimits(markdownToBlocks(sanitizeMarkdownLinks(content)));
  if (linksTo.length > 0) children.push(metaBlock(`Related pages: ${linksTo.join(', ')}`));
  children.push(metaBlock(`Created: ${changeMeta()}`));

  const page = await notion.pages.create({
    parent: { page_id: parentId },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
    children: children.slice(0, 100),
  });
  for (let i = 100; i < children.length; i += 100) {
    await notion.blocks.children.append({
      block_id: page.id,
      children: children.slice(i, i + 100),
    });
  }
  return page.id;
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

  console.log(chalk.magenta('Fetching Notion page tree…'));
  const existingPages = await fetchPageTree(rootId);
  console.log(`  Found ${chalk.bold(existingPages.length)} pages:`);
  for (const p of existingPages) {
    console.log(`    ${chalk.magenta(p.title)} ${chalk.dim(p.path !== p.title ? `(${p.path})` : '')}`);
  }

  console.log('');
  console.log(chalk.magenta('Fetching page summaries…'));
  let summaryFailed = 0;
  let summaryChars = 0;
  for (const page of existingPages) {
    try {
      const raw = await fetchPageSummary(page.id);
      page.summary = raw
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);
      summaryChars += page.summary.length;
    } catch (err) {
      summaryFailed++;
      console.warn(chalk.yellow(`  ⚠ Failed to fetch summary for "${page.title}": ${err.message}`));
      page.summary = '(summary unavailable)';
    }
  }
  const summaryOk = existingPages.length - summaryFailed;
  console.log(`  ${chalk.green(`${summaryOk} OK`)}${summaryFailed ? `, ${chalk.yellow(`${summaryFailed} failed`)}` : ''} ${chalk.dim(`(${Math.round(summaryChars / 1024)}KB total)`)}`);

  const prompt = `You are a product documentation agent for Strive, an AI-powered learning platform.
You are operating in the **${REPO_LABEL}** repository.

${DOC_STANDARDS.DOCUMENTATION_PHILOSOPHY}

${DOC_STANDARDS.UPDATE_RULES}

${DOC_STANDARDS.WRITING_STANDARDS}

${DOC_STANDARDS.QUALITY_CRITERIA}

${DOC_STANDARDS.PAGE_STRUCTURE}

${DOC_STANDARDS.LINK_STANDARDS}

DOCUMENTATION STRUCTURE
You manage the "How Strive Works" section — product-level documentation that explains
what the platform does, how features work, and the business logic behind them.
These pages are read by everyone: developers, product managers, and leadership.

CRITICAL: Your output must contain ZERO code references. No file paths, no function
names, no API endpoints, no schema fields, no inline code backticks. Describe everything
in plain language. If a code change adds a new validation step, write "the system now
validates X before proceeding" — not "contentValidation.ts filters blocks with < 20 chars".

The "How Strive Works" pages you can update (with current content summaries):
${existingPages.map((p) => `- "${p.title}" (${p.path}) [${p.id}]\n  Current content: ${p.summary || '(empty)'}`).join('\n\n') || '(empty — first sync)'}

Root page ID: ${rootId}

CHANGE CONTEXT
Repository: ${process.env.REPO_NAME}
${prRef()}: ${process.env.PR_TITLE}
Author: ${process.env.PR_AUTHOR}
Description: ${process.env.PR_BODY || 'None provided'}

Changed files:
${process.env.CHANGED_FILES}

Diff (truncated):
${diff}

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

1. **rewrite** — Replace the full content of an existing page with updated documentation.
   Always rewrite the complete page — never append or patch. Use the page's current
   content summary above as the starting point and integrate changes.
   Remember: NO code references in the output.

2. **create** — Create a new page only when the change introduces a genuinely new
   feature area that has no home in the existing structure.

3. **skip** — Most changes. Product docs only update when user-facing behavior changes.

Respond ONLY in valid JSON (no markdown fences):
{
  "meaningful": boolean,
  "reasoning": "One sentence: your product-level assessment of whether this change affects what users experience or how features work",
  "actions": [
    {
      "type": "rewrite",
      "page_id": "id",
      "page_title": "title",
      "content": "Complete replacement content — NO code references, written for a non-technical audience"
    },
    {
      "type": "create",
      "parent_id": "id",
      "title": "New Page Title",
      "content": "Page content — NO code references"
    }
  ]
}`;

  console.log('');
  console.log(chalk.magenta('Asking Claude to assess product documentation impact…'));
  console.log(chalk.dim(`  Prompt: ${Math.round(prompt.length / 1024)}KB, ${existingPages.length} pages, diff ${Math.round(diff.length / 1024)}KB`));

  const MAX_RETRIES = 3;
  let result;
  let usage;
  let aiElapsed;
  let messages = [{ role: 'user', content: prompt }];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const aiStart = Date.now();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      messages,
    });

    usage = response.usage;
    aiElapsed = Math.round((Date.now() - aiStart) / 1000);
    console.log(`  Responded in ${chalk.bold(`${aiElapsed}s`)} ${chalk.dim(`— ${usage.input_tokens} in, ${usage.output_tokens} out`)}`);

    if (response.stop_reason === 'max_tokens') {
      console.warn(chalk.yellow(`  ⚠ Response truncated (hit max_tokens) — attempt ${attempt}/${MAX_RETRIES}`));
      if (attempt < MAX_RETRIES) {
        console.log(chalk.dim('  Retrying…'));
        messages = [{ role: 'user', content: prompt }];
        continue;
      }
      throw new Error('Claude response truncated (max_tokens) after all retries');
    }

    const rawText = response.content[0].text;
    try {
      const raw = rawText.replace(/```json|```/g, '').trim();
      result = JSON.parse(raw);
      break;
    } catch (err) {
      console.error(chalk.red(`  Parse error (attempt ${attempt}/${MAX_RETRIES}):`), rawText.slice(0, 500));
      if (attempt < MAX_RETRIES) {
        console.log(chalk.dim('  Retrying with error feedback…'));
        messages = [
          { role: 'user', content: prompt },
          { role: 'assistant', content: rawText },
          { role: 'user', content: `Your previous response was invalid JSON. Error: ${err.message}\nPlease respond again with ONLY valid JSON matching the required schema. Ensure all strings are properly escaped and the JSON is complete.` },
        ];
        continue;
      }
      throw new Error(`JSON parse error after ${MAX_RETRIES} attempts: ${err.message}`);
    }
  }

  console.log(`  Meaningful: ${result.meaningful ? chalk.green('yes') : chalk.yellow('no')}`);
  console.log(`  Reasoning:  ${chalk.italic(result.reasoning)}`);

  if (!result.meaningful || !result.actions?.length) {
    console.log(chalk.dim('\nNo product documentation updates needed.'));
    return;
  }

  // Validate page_ids against the fetched tree
  const validIds = new Set(existingPages.map((p) => p.id));
  validIds.add(rootId);

  console.log('');
  console.log(chalk.magenta(`Executing ${result.actions.length} action(s)…`));

  const log = [];

  for (const action of result.actions) {
    const actionLabel = action.page_title || action.title;

    const targetId = action.page_id || action.parent_id;
    if (targetId && !validIds.has(targetId)) {
      console.warn(chalk.yellow(`  ⚠ Skipping ${action.type} on "${actionLabel}": page_id ${targetId} not found in Notion tree`));
      log.push({ status: 'warn', type: action.type, page: actionLabel, id: targetId, detail: 'Invalid page_id — not in tree' });
      continue;
    }

    try {
      switch (action.type) {
        case 'rewrite':
          if (!action.content) throw new Error('Missing content for rewrite action');
          await rewritePage(action.page_id, action.content);
          log.push({
            status: 'ok',
            type: action.type,
            page: actionLabel,
            id: action.page_id,
            detail: `${action.content.length} chars`,
          });
          break;
        case 'create': {
          if (!action.content) throw new Error('Missing content for create action');
          const newId = await createPage(action.parent_id, action.title, action.content, action.links_to || []);
          log.push({ status: 'ok', type: action.type, page: actionLabel, id: newId, detail: `parent: ${action.parent_id}` });
          break;
        }
        default:
          log.push({ status: 'warn', type: action.type, page: actionLabel, id: '—', detail: 'Unknown action type' });
          continue;
      }
      console.log(`  ${chalk.green('✓')} ${chalk.bold(action.type)} "${actionLabel}"`);
    } catch (err) {
      log.push({
        status: 'error',
        type: action.type,
        page: actionLabel,
        id: action.page_id || action.parent_id,
        detail: err.message,
      });
      console.log(`  ${chalk.red('✗')} ${chalk.bold(action.type)} "${actionLabel}" — ${chalk.red(err.message)}`);
    }
  }

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const succeeded = log.filter((e) => e.status === 'ok').length;
  const failed = log.filter((e) => e.status === 'error').length;
  const skipped = log.filter((e) => e.status === 'warn').length;

  console.log('');
  console.log(separator());
  console.log(chalk.bold('PRODUCT SYNC SUMMARY'));
  console.log(separator());
  console.log(label('Change:   ', `${prRef()}: ${process.env.PR_TITLE}`));
  console.log(label('Reasoning:', chalk.italic(result.reasoning)));
  console.log(label('Actions:  ', [
    succeeded && chalk.green(`${succeeded} succeeded`),
    failed && chalk.red(`${failed} failed`),
    skipped && chalk.yellow(`${skipped} skipped`),
  ].filter(Boolean).join(', ')));
  console.log(label('Tokens:   ', chalk.dim(`${usage.input_tokens} in, ${usage.output_tokens} out`)));
  console.log(label('Duration: ', `${elapsed}s ${chalk.dim(`(AI: ${aiElapsed}s)`)}`));
  console.log('');
  for (const entry of log) {
    const icon = entry.status === 'ok' ? chalk.green('✓') : entry.status === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
    console.log(`  ${icon} ${chalk.bold(entry.type.padEnd(10))} "${entry.page}" ${chalk.dim(`[${entry.id}]`)}`);
    console.log(`    ${chalk.dim(entry.detail)}`);
  }
  console.log(separator());
}

main().catch((err) => {
  console.error(chalk.red.bold('Product sync failed:'), err.message);
  process.exit(1);
});
