const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
const { markdownToBlocks } = require('@tryfabric/martian');
const chalk = require('chalk');
const DOC_STANDARDS = require('./doc-standards');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DELAY_MS = 350; // stay under Notion's 3 req/s limit

function sanitizeMarkdownLinks(markdown) {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (/^https?:\/\//i.test(url)) return match;
    return `\`${text}\``;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO_LABEL = process.env.REPO_LABEL;

// Page IDs to skip (belong to other repos)
// Normalize: strip hyphens so both "abc123" and "abc-123" formats match
const SKIP_PAGE_IDS = new Set(
  (process.env.SKIP_PAGE_IDS?.split(',') || []).map((id) => id.replace(/-/g, ''))
);

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
        if (SKIP_PAGE_IDS.has(block.id.replace(/-/g, ''))) continue;
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
  // Skip child_page blocks — they're navigation, not content
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

/** Split a single rich_text element into chunks that fit within Notion's 2000-char limit. */
function splitRichText(rt) {
  if (!rt.text?.content) return [rt]; // non-text types (equation, mention) — pass through
  const text = rt.text.content;
  if (text.length <= RICH_TEXT_LIMIT) return [rt];
  const chunks = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_LIMIT) {
    chunks.push({ ...rt, text: { ...rt.text, content: text.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return chunks;
}

/** Ensure every block's rich_text stays within the 2000-char limit. */
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

function divider() {
  return { object: 'block', type: 'divider', divider: {} };
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
  // Archive all existing blocks, then write fresh content
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

  // Convert markdown to Notion blocks (preserves formatting)
  const children = enforceRichTextLimits(markdownToBlocks(sanitizeMarkdownLinks(content)));
  children.push(metaBlock(`Rewritten: ${changeMeta()}`));

  // Notion limits appending to 100 blocks at a time
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

  // Notion limits children to 100 blocks per call — create with first batch, append the rest
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

async function crosslinkPage(pageId, note) {
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      divider(),
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{ type: 'text', text: { content: `Cross-repo update (${prRef()}): ${note}` } }],
          icon: { type: 'emoji', emoji: '🔗' },
          color: 'blue_background',
        },
      },
      metaBlock(changeMeta()),
    ],
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const rootId = process.env.NOTION_TECHNICAL_ROOT_ID;
  if (!rootId) throw new Error('NOTION_TECHNICAL_ROOT_ID is required');

  // Log change context
  const changedFiles = (process.env.CHANGED_FILES || '').split('\n').filter(Boolean);
  const diff = fs.readFileSync('/tmp/pr_diff.txt', 'utf8');
  console.log('');
  console.log(chalk.bold.cyan('KNOWLEDGE BASE SYNC'));
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

  if (SKIP_PAGE_IDS.size) console.log(chalk.dim(`  Skipping page IDs: ${[...SKIP_PAGE_IDS].join(', ')}`));
  console.log(chalk.cyan('Fetching Notion page tree…'));
  const existingPages = await fetchPageTree(rootId);
  console.log(`  Found ${chalk.bold(existingPages.length)} pages:`);
  for (const p of existingPages) {
    console.log(`    ${chalk.cyan(p.title)} ${chalk.dim(p.path !== p.title ? `(${p.path})` : '')}`);
  }

  console.log('');
  console.log(chalk.cyan('Fetching page summaries…'));
  let summaryFailed = 0;
  let summaryChars = 0;
  for (const page of existingPages) {
    try {
      const raw = await fetchPageSummary(page.id);
      // Sanitize: collapse whitespace, remove non-printable chars, trim length
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

  const prompt = `You are a living documentation agent for this project.
You are operating in the **${REPO_LABEL}** repository.

${DOC_STANDARDS.DOCUMENTATION_PHILOSOPHY}

${DOC_STANDARDS.UPDATE_RULES}

${DOC_STANDARDS.WRITING_STANDARDS}

${DOC_STANDARDS.QUALITY_CRITERIA}

${DOC_STANDARDS.PAGE_STRUCTURE}

${DOC_STANDARDS.LINK_STANDARDS}

DOCUMENTATION STRUCTURE
All documentation lives in Notion under two top-level sections:
- **Product** — manually curated vision, features, and strategy docs. NEVER modify these.
- **Technical** — architecture, conventions, and implementation docs. This is your scope.

The Technical section you can update (with current content summaries):
${existingPages.map((p) => `- "${p.title}" (${p.path}) [${p.id}]\n  Current content: ${p.summary || '(empty)'}`).join('\n\n') || '(empty — first sync)'}

Technical root page ID: ${rootId}

CHANGE CONTEXT
Repository: ${process.env.REPO_NAME}
${prRef()}: ${process.env.PR_TITLE}
Author: ${process.env.PR_AUTHOR}
Description: ${process.env.PR_BODY || 'None provided'}

Changed files:
${process.env.CHANGED_FILES}

Diff (truncated):
${diff}

ACTIONS

1. **rewrite** — PREFERRED for all changes. Replace the full content of an existing
   page with corrected, up-to-date documentation. Always rewrite the complete page —
   never append or patch. You have the page's current content in the summary above —
   use it as the starting point and integrate the changes into a clean, consolidated version.

2. **create** — Create a new page only when the change introduces a concept, system,
   or integration pattern that genuinely has no home in the existing structure.
   Place it under the correct parent using parent_id from the tree above.

3. **crosslink** — Add a cross-reference note to a page when a change in this repo
   has implications for documentation in another section (e.g., a client auth change
   that affects the system-wide Authentication page).

4. **skip** — If the change is trivial (dependency bump, formatting, minor CSS,
   test-only, internal refactor that doesn't change public behavior or introduce
   new patterns).

HIERARCHY RULES
- Changes to this repo's internals → under this repo's section in the tree
- Changes to how repos communicate → under the system-wide section
- Auth changes → system-wide auth page if cross-repo, repo-specific if isolated
- New external service integration → system-wide or repo-specific depending on scope
- Never create a page at root level unless it is a genuinely top-level concern

Respond ONLY in valid JSON (no markdown fences):
{
  "meaningful": boolean,
  "reasoning": "One sentence: your architectural assessment of this change's documentation impact",
  "actions": [
    {
      "type": "rewrite",
      "page_id": "id",
      "page_title": "title",
      "content": "Complete replacement content for the page"
    },
    {
      "type": "create",
      "parent_id": "id",
      "title": "New Page Title",
      "content": "Page content written as living documentation",
      "links_to": ["related-page-id"]
    },
    {
      "type": "crosslink",
      "page_id": "id",
      "page_title": "title",
      "note": "What changed and why this section should know"
    }
  ]
}`;

  console.log('');
  console.log(chalk.cyan('Asking Claude to assess documentation impact…'));
  console.log(chalk.dim(`  Prompt: ${Math.round(prompt.length / 1024)}KB, ${existingPages.length} pages, diff ${Math.round(diff.length / 1024)}KB`));
  const aiStart = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16384,
    messages: [{ role: 'user', content: prompt }],
  });

  const { usage } = response;
  const aiElapsed = Math.round((Date.now() - aiStart) / 1000);
  console.log(`  Responded in ${chalk.bold(`${aiElapsed}s`)} ${chalk.dim(`— ${usage.input_tokens} in, ${usage.output_tokens} out`)}`);

  let result;
  try {
    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    result = JSON.parse(raw);
  } catch (err) {
    console.error(chalk.red('Failed to parse Claude response:'), response.content[0].text.slice(0, 500));
    throw new Error(`JSON parse error: ${err.message}`);
  }

  console.log(`  Meaningful: ${result.meaningful ? chalk.green('yes') : chalk.yellow('no')}`);
  console.log(`  Reasoning:  ${chalk.italic(result.reasoning)}`);

  if (!result.meaningful || !result.actions?.length) {
    console.log(chalk.dim('\nNo documentation updates needed.'));
    return;
  }

  // Validate page_ids against the fetched tree to catch hallucinated IDs
  const validIds = new Set(existingPages.map((p) => p.id));
  validIds.add(rootId);

  console.log('');
  console.log(chalk.cyan(`Executing ${result.actions.length} action(s)…`));

  const log = [];

  for (const action of result.actions) {
    const label = action.page_title || action.title;

    // Validate page_id / parent_id exists in the tree
    const targetId = action.page_id || action.parent_id;
    if (targetId && !validIds.has(targetId)) {
      console.warn(chalk.yellow(`  ⚠ Skipping ${action.type} on "${label}": page_id ${targetId} not found in Notion tree`));
      log.push({ status: 'warn', type: action.type, page: label, id: targetId, detail: 'Invalid page_id — not in tree' });
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
            page: label,
            id: action.page_id,
            detail: `${action.content.length} chars`,
          });
          break;
        case 'create': {
          if (!action.content) throw new Error('Missing content for create action');
          const newId = await createPage(action.parent_id, action.title, action.content, action.links_to || []);
          log.push({ status: 'ok', type: action.type, page: label, id: newId, detail: `parent: ${action.parent_id}` });
          break;
        }
        case 'crosslink':
          await crosslinkPage(action.page_id, action.note);
          log.push({
            status: 'ok',
            type: action.type,
            page: label,
            id: action.page_id,
            detail: action.note.slice(0, 120),
          });
          break;
        default:
          log.push({ status: 'warn', type: action.type, page: label, id: '—', detail: 'Unknown action type' });
          continue;
      }
      console.log(`  ${chalk.green('✓')} ${chalk.bold(action.type)} "${label}"`);
    } catch (err) {
      log.push({
        status: 'error',
        type: action.type,
        page: label,
        id: action.page_id || action.parent_id,
        detail: err.message,
      });
      console.log(`  ${chalk.red('✗')} ${chalk.bold(action.type)} "${label}" — ${chalk.red(err.message)}`);
    }
  }

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const succeeded = log.filter((e) => e.status === 'ok').length;
  const failed = log.filter((e) => e.status === 'error').length;
  const skipped = log.filter((e) => e.status === 'warn').length;

  console.log('');
  console.log(separator());
  console.log(chalk.bold('SYNC SUMMARY'));
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
  console.error(chalk.red.bold('Sync failed:'), err.message);
  process.exit(1);
});
