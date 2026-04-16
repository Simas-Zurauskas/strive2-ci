/**
 * notion-tool.js — CLI for Claude Code to manage Notion documentation pages.
 *
 * Usage:
 *   node notion-tool.js list
 *   node notion-tool.js rewrite <page_id> <markdown_file>
 *   node notion-tool.js append <page_id> <markdown_file>
 *   node notion-tool.js create <parent_id> "<title>" <markdown_file>
 *   node notion-tool.js delete <page_id>
 *   node notion-tool.js rename <page_id> "<new_title>"
 *
 * Markdown files are converted to Notion blocks automatically.
 * Requires NOTION_API_KEY and NOTION_ROOT_ID env vars.
 */

const fs = require('fs');
const { Client } = require('@notionhq/client');
const { markdownToBlocks } = require('@tryfabric/martian');
const chalk = require('chalk');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ---------------------------------------------------------------------------
// Markdown sanitization — strip links that Notion will reject
// ---------------------------------------------------------------------------

function sanitizeMarkdownLinks(markdown) {
  // Replace markdown links whose URL is not an absolute http(s) URL
  // [text](bad-url) → `text` (or just text if already in backticks)
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (/^https?:\/\//i.test(url)) return match; // valid absolute URL — keep
    return `\`${text}\``; // convert to inline code
  });
}

// ---------------------------------------------------------------------------
// Block post-processing — fix table rows with mismatched cell counts
// ---------------------------------------------------------------------------

function normalizeTableBlocks(blocks) {
  for (const block of blocks) {
    if (block.type === 'table' && block.table?.children) {
      const width = block.table.table_width;
      for (const row of block.table.children) {
        if (row.type !== 'table_row') continue;
        const cells = row.table_row.cells;
        // Trim extra cells
        if (cells.length > width) {
          cells.length = width;
        }
        // Pad missing cells with empty rich text
        while (cells.length < width) {
          cells.push([{ type: 'text', text: { content: '' } }]);
        }
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Notion operations
// ---------------------------------------------------------------------------

async function listPages() {
  const rootId = process.env.NOTION_ROOT_ID;
  if (!rootId) throw new Error('NOTION_ROOT_ID is required');

  const pages = [];
  async function walk(blockId, path = '') {
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
          await walk(block.id, fullPath);
        }
      }
      cursor = res.next_cursor;
    } while (cursor);
  }

  await walk(rootId);
  console.log(JSON.stringify(pages, null, 2));
}

async function appendBlocks(pageId, blocks) {
  // Notion limits to 100 blocks per request
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + 100),
    });
  }
}

async function rewritePage(pageId, markdownFile) {
  const markdown = sanitizeMarkdownLinks(fs.readFileSync(markdownFile, 'utf8'));
  const newBlocks = normalizeTableBlocks(markdownToBlocks(markdown));

  // 1. Collect existing content block IDs (never touch child pages or databases)
  const oldBlockIds = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of res.results) {
      if (block.type === 'child_page' || block.type === 'child_database') continue;
      oldBlockIds.push(block.id);
    }
    cursor = res.next_cursor;
  } while (cursor);

  // 2. Append new content first (safe — old content still exists if this fails)
  await appendBlocks(pageId, newBlocks);

  // 3. Delete old content blocks now that new content is in place
  for (const blockId of oldBlockIds) {
    try {
      await notion.blocks.delete({ block_id: blockId });
    } catch (_) {
      // Some block types can't be deleted — skip
    }
  }

  console.log(`${chalk.green('✓')} Rewrote page ${chalk.dim(pageId)} ${chalk.dim(`(${newBlocks.length} new, ${oldBlockIds.length} old removed)`)}`);
}

async function appendToPage(pageId, markdownFile) {
  const markdown = sanitizeMarkdownLinks(fs.readFileSync(markdownFile, 'utf8'));
  const blocks = normalizeTableBlocks(markdownToBlocks(markdown));
  await appendBlocks(pageId, blocks);
  console.log(`${chalk.green('✓')} Appended to page ${chalk.dim(pageId)} ${chalk.dim(`(${blocks.length} blocks)`)}`);
}

async function createPage(parentId, title, markdownFile) {
  const markdown = sanitizeMarkdownLinks(fs.readFileSync(markdownFile, 'utf8'));
  const blocks = normalizeTableBlocks(markdownToBlocks(markdown));

  // Notion limits children in create to 100
  const initialBlocks = blocks.slice(0, 100);
  const page = await notion.pages.create({
    parent: { page_id: parentId },
    properties: {
      title: { title: [{ type: 'text', text: { content: title } }] },
    },
    children: initialBlocks,
  });

  // Append remaining blocks if any
  if (blocks.length > 100) {
    await appendBlocks(page.id, blocks.slice(100));
  }

  console.log(`${chalk.green('✓')} Created page "${chalk.cyan(title)}" [${page.id}] ${chalk.dim(`under ${parentId} (${blocks.length} blocks)`)}`);
}

async function deletePage(pageId) {
  await notion.pages.update({
    page_id: pageId,
    archived: true,
  });
  console.log(`${chalk.green('✓')} Archived page ${chalk.dim(pageId)}`);
}

async function renamePage(pageId, newTitle) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      title: { title: [{ type: 'text', text: { content: newTitle } }] },
    },
  });
  console.log(`${chalk.green('✓')} Renamed page ${chalk.dim(pageId)} to "${chalk.cyan(newTitle)}"`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'list':
      await listPages();
      break;

    case 'rewrite':
      if (args.length < 2) throw new Error('Usage: rewrite <page_id> <markdown_file>');
      await rewritePage(args[0], args[1]);
      break;

    case 'append':
      if (args.length < 2) throw new Error('Usage: append <page_id> <markdown_file>');
      await appendToPage(args[0], args[1]);
      break;

    case 'create':
      if (args.length < 3) throw new Error('Usage: create <parent_id> "<title>" <markdown_file>');
      await createPage(args[0], args[1], args[2]);
      break;

    case 'delete':
      if (args.length < 1) throw new Error('Usage: delete <page_id>');
      await deletePage(args[0]);
      break;

    case 'rename':
      if (args.length < 2) throw new Error('Usage: rename <page_id> "<new_title>"');
      await renamePage(args[0], args[1]);
      break;

    default:
      console.error(chalk.red(`${'✗'} Unknown command: ${command}`));
      console.error(chalk.dim('Commands: list, rewrite, append, create, delete, rename'));
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${chalk.red('✗')} ${err.message}`);
  process.exit(1);
});
