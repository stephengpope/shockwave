// Action-driven inline AI features.
//
// Each action has:
//   - id              — the dispatch key the renderer sends in ai:run
//   - systemPrompt    — pinned for that action; baked with MARKDOWN_REFERENCE
//   - buildUserMessage(params) — turns the renderer's inputs into the user
//                       message that goes to the model
//
// To add another action (e.g. "summarize", "translate"), drop a new entry in
// ACTIONS. The IPC handler and useInlineAi hook are action-agnostic.

const MARKDOWN_REFERENCE = `The document is rendered by an editor that supports:
- Headings (\`#\` through \`######\`)
- Bold (\`**text**\`)
- Italic (\`*text*\`)
- Inline code (\`\`code\`\`)
- Fenced code blocks (\`\`\`...\`\`\`)
- Bullet lists (\`-\`, \`*\`, \`+\`) and numbered lists (\`1.\`)
- Task lists (\`- [ ]\`, \`- [x]\`)
- Blockquotes (\`>\`)
- Horizontal rules (\`---\`)
- Wiki-links to other notes in the vault (\`[[Note Name]]\`)
- Markdown links (\`[text](url)\`)
- Bare URLs (auto-linked)

Do NOT use: tables, strikethrough (\`~~\`), highlight (\`==\`), footnotes (\`[^1]\`), math (\`$\`), HTML, frontmatter, or emoji shortcodes — they will appear as raw text in the editor.

Never output the literal strings \`<<CURSOR>>\`, \`<<SELECTION>>\`, or \`</SELECTION>>\` — those are context markers, not content.`;

const INSERT_SYSTEM = `You are inserting your reply at the user's cursor position in their own document. Return ONLY the answer to the instruction. No preamble ("Sure", "Here is"), no commentary, no sign-off, no surrounding quotes or code fences. Match the surrounding document's tone.

${MARKDOWN_REFERENCE}`;

const REWRITE_SYSTEM = `You are rewriting a passage in the user's document. Return ONLY the rewritten passage. Preserve the original markdown formatting style unless the instruction asks otherwise. No preamble, no commentary, no sign-off, no surrounding quotes or code fences.

${MARKDOWN_REFERENCE}`;

// Params arriving from the renderer for INSERT:
//   { userPrompt, contextBefore, contextAfter, includeContext }
function buildInsertUserMessage({ userPrompt, contextBefore, contextAfter, includeContext }) {
  if (!includeContext) {
    return `Instruction: ${userPrompt}`;
  }
  return [
    'Document context (your reply will be inserted at <<CURSOR>>):',
    '',
    `${contextBefore ?? ''}<<CURSOR>>${contextAfter ?? ''}`,
    '',
    `Instruction: ${userPrompt}`,
  ].join('\n');
}

// Params arriving from the renderer for REWRITE:
//   { userPrompt, selection, contextBefore, contextAfter, includeContext }
function buildRewriteUserMessage({ userPrompt, selection, contextBefore, contextAfter, includeContext }) {
  if (!includeContext) {
    return [
      'Passage to rewrite:',
      selection,
      '',
      `Instruction: ${userPrompt}`,
    ].join('\n');
  }
  return [
    'Document context (rewrite ONLY the passage between <<SELECTION>> and </SELECTION>>; do not rewrite anything else):',
    '',
    `${contextBefore ?? ''}<<SELECTION>>${selection}</SELECTION>>${contextAfter ?? ''}`,
    '',
    `Instruction: ${userPrompt}`,
  ].join('\n');
}

const ACTIONS = {
  insert: {
    id: 'insert',
    systemPrompt: INSERT_SYSTEM,
    buildUserMessage: buildInsertUserMessage,
  },
  rewrite: {
    id: 'rewrite',
    systemPrompt: REWRITE_SYSTEM,
    buildUserMessage: buildRewriteUserMessage,
  },
};

function getAction(id) {
  return ACTIONS[id] ?? null;
}

export { ACTIONS, getAction };
