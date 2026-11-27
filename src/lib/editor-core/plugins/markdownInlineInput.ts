import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { isHistoryTransaction } from 'prosemirror-history';
import { Plugin, PluginKey, TextSelection, type Transaction } from 'prosemirror-state';
import { Mapping } from 'prosemirror-transform';
import { isPlainTextPaste, verbatimTextPasteMeta } from '../clipboardMarkdown';
import { analyzeInlineSource, isInlineSourceBlock } from '../InlineSourceCodec';
import { getInlineMarkdownSource, retainInlineMarkdownSpelling } from '../inlineMarkdownSpelling';
import { getInlineMarkdownRanges, serializeMarkdown, tryParseMarkdown } from '../markdown';
import { isInlineSourceComposing } from './inlineSourceEditing';
import { beginMarkdownSourceEdit, getMarkdownSourceEdit, isMarkdownSourceProjection, requestMarkdownSourceEditor } from './markdownSourceEditor';

interface TextRange {
  from: number;
  to: number;
}

const promotionMeta = 'nomoMarkdownInlinePromotion';
const promotionKey = new PluginKey<TextRange | null>('markdownInlineInput');

function changedTextRanges(transactions: readonly Transaction[]): TextRange[] {
  const mapping = new Mapping();
  const changes = transactions.map((transaction) => {
    mapping.appendMapping(transaction.mapping);
    return { range: transaction.changedRange(), after: mapping.maps.length };
  });
  return changes.flatMap(({ range, after }) => {
    if (!range) return [];
    const remaining = mapping.slice(after);
    return [{ from: remaining.map(range.from, -1), to: remaining.map(range.to, 1) }];
  });
}

function isOrdinarySource(node: ProseMirrorNode): boolean {
  return node.isText && node.marks.every((mark) => mark.type.name === 'inline_source' && !mark.attrs.literal);
}

function touches(changes: readonly TextRange[], from: number, to: number): boolean {
  return changes.some((change) => change.from <= to && change.to >= from);
}

function canPromoteText(doc: ProseMirrorNode, from: number, to: number): boolean {
  let canPromote = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !isOrdinarySource(node)) canPromote = false;
  });
  return canPromote;
}

function inlineText(block: ProseMirrorNode): string {
  return block.textBetween(0, block.content.size, '', (node) => node.type.name === 'hard_break' ? '\n' : '\ufffc');
}

const inlineObjects = new Set(['image', 'footnote_ref', 'math_inline', 'comment_inline', 'html_anchor']);

/** A newly wrapped code span can contain an already rendered link or inline node. */
function restoreSourceInsideCode(
  tr: Transaction,
  block: ProseMirrorNode,
  pos: number,
  changes: readonly TextRange[],
): boolean {
  const start = pos + 1;
  const code = analyzeInlineSource(block).spans.filter((span) => span.type === 'code' &&
    touches(changes, start + span.openFrom, start + span.closeTo));
  if (!code.length) return false;

  const { doc, paragraph } = tr.doc.type.schema.nodes;
  const { inline_source } = tr.doc.type.schema.marks;
  const edits: Array<TextRange & { source: string }> = [];
  for (let index = 0, offset = 0; index < block.childCount;) {
    const child = block.child(index);
    const link = child.marks.find((mark) => mark.type.name === 'link');
    const from = offset;
    offset += child.nodeSize;
    index++;
    if (link) {
      while (index < block.childCount && link.isInSet(block.child(index).marks)) {
        offset += block.child(index++).nodeSize;
      }
    } else if (!inlineObjects.has(child.type.name)) {
      continue;
    }
    if (!code.some((span) => from >= span.from && offset <= span.to)) continue;
    const content = block.content.cut(from, offset);
    const original = getInlineMarkdownSource(link ?? child);
    const source = original && (!link || tryParseMarkdown(original)?.firstChild?.content.eq(content))
      ? original : serializeMarkdown(doc.create(null, paragraph.create(null, content)));
    if (source) edits.push({ from: start + from, to: start + offset, source });
  }
  for (const { from, to, source } of edits.reverse()) {
    tr.replaceWith(from, to, tr.doc.type.schema.text(source, [inline_source.create()]));
  }
  return !!edits.length;
}

function promoteFootnoteDefinition(
  tr: Transaction,
  block: ProseMirrorNode,
  source: string,
  pos: number,
  changes: readonly TextRange[],
): boolean {
  const { paragraph, footnote_def, footnote_ref } = tr.doc.type.schema.nodes;
  if (block.type !== paragraph || (!source.startsWith('\ufffc') && !/^ {0,3}\[\^/.test(source))) return false;
  const first = block.firstChild;
  const existing = first?.type === footnote_ref && !first.marks.length ? first : null;
  const raw = existing ? /^\ufffc:[ \t]*/.exec(source) : /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*/.exec(source);
  if (!raw || source.includes('\n')) return false;

  const from = pos + 1;
  const to = from + raw[0].length;
  const rawStart = from + (existing?.nodeSize ?? 0);
  if (!touches(changes, from, to) || !canPromoteText(tr.doc, rawStart, to)) return false;
  const $pos = tr.doc.resolve(pos);
  const index = $pos.index();
  if (!$pos.parent.canReplaceWith(index, index + 1, footnote_def)) return false;

  const id = existing ? String(existing.attrs.id) : raw[1];
  const sourcePrefix = existing ? (getInlineMarkdownSource(existing) ?? `[^${id}]`) + raw[0].slice(1) : raw[0];
  tr.delete(from, to);
  tr.setNodeMarkup(pos, footnote_def, { id, sourcePrefix });
  return true;
}

/** Promote syntax after user edits, including deletions and multi-character input. */
export function markdownInlineInputPlugin(isEditable: () => boolean): Plugin<TextRange | null> {
  return new Plugin<TextRange | null>({
    key: promotionKey,
    state: {
      init: () => null,
      apply(transaction, pending, _oldState, state) {
        if (!isInlineSourceComposing(state)) return null;
        const change = transaction.changedRange();
        if (!pending || !transaction.docChanged) return change ?? pending;
        const from = transaction.mapping.map(pending.from, -1);
        const to = transaction.mapping.map(pending.to, 1);
        return change ? { from: Math.min(from, change.from), to: Math.max(to, change.to) } : { from, to };
      },
    },
    appendTransaction(transactions, oldState, state) {
      if (!isEditable() || isInlineSourceComposing(state) ||
          isPlainTextPaste(transactions) || transactions.some(isHistoryTransaction) ||
          transactions.every(isMarkdownSourceProjection) ||
          transactions.some((transaction) => transaction.getMeta(promotionMeta))) return null;

      const changes = changedTextRanges(transactions);
      const pasted = transactions.some((tr) => tr.getMeta(verbatimTextPasteMeta));
      const composed = promotionKey.getState(oldState);
      if (composed) {
        const mapping = new Mapping();
        for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
        changes.push({ from: mapping.map(composed.from, -1), to: mapping.map(composed.to, 1) });
      }
      if (!changes.length) return null;

      const blocks = new Set<number>();
      for (const { from, to } of changes) {
        state.doc.nodesBetween(Math.max(0, from - 1), Math.min(state.doc.content.size, to + 1), (node, pos) => {
          if (isInlineSourceBlock(node)) blocks.add(pos);
          return !node.isTextblock;
        });
      }

      const tr = state.tr;
      const sourceEdit = getMarkdownSourceEdit(state);
      let active: { pos: number; after: number; offset: number } | undefined;
      let pastedSource: (TextRange & { after: number }) | undefined;
      for (const pos of [...blocks].sort((a, b) => b - a)) {
        const block = tr.doc.nodeAt(pos);
        if (!block) continue;
        let source = inlineText(block);
        const from = pos + 1;
        const to = from + block.content.size;
        if (pasted && !sourceEdit && block.type.name === 'paragraph' && /^ {0,3}\[\^[^\]\s]+\]:/.test(source) &&
            tr.selection.empty && tr.selection.from >= from && tr.selection.from <= to &&
            !source.includes('\n') && canPromoteText(tr.doc, from, to)) {
          pastedSource = { from, to, after: tr.mapping.maps.length };
          continue;
        }
        if (promoteFootnoteDefinition(tr, block, source, pos, changes)) source = inlineText(tr.doc.nodeAt(pos)!);
        if (source.includes('`') && restoreSourceInsideCode(tr, tr.doc.nodeAt(pos)!, pos, changes)) {
          source = inlineText(tr.doc.nodeAt(pos)!);
        }
        if (!source.includes('](') && !source.includes('[^')) continue;

        const mappedChanges = changes.map(({ from, to }) => ({
          from: tr.mapping.map(from, -1), to: tr.mapping.map(to, 1),
        }));
        for (const range of getInlineMarkdownRanges(source).reverse()) {
          const from = pos + 1 + range.from;
          const to = pos + 1 + range.to;
          if (sourceEdit && from < tr.mapping.map(sourceEdit.to, 1) && to > tr.mapping.map(sourceEdit.from, -1)) continue;
          if (!touches(mappedChanges, from, to) || !canPromoteText(tr.doc, from, to)) continue;
          if (pasted && tr.selection.empty && tr.selection.from >= from && tr.selection.from <= to) {
            pastedSource = { from, to, after: tr.mapping.maps.length };
            continue;
          }
          const parsed = tryParseMarkdown(source.slice(range.from, range.to))?.firstChild;
          if (parsed?.type !== state.schema.nodes.paragraph || !parsed.content.size) continue;
          const parent = tr.doc.resolve(from);
          const next = parent.parent.content.cut(0, parent.parentOffset)
            .append(parsed.content).append(parent.parent.content.cut(to - parent.start()));
          if (!parent.parent.type.validContent(next)) continue;

          const { selection } = tr;
          const offset = selection.empty && selection.from > from && selection.from < to
            ? selection.from - from : undefined;
          retainInlineMarkdownSpelling(parsed.content);
          tr.replaceWith(from, to, parsed.content);
          if (offset !== undefined) active = { pos: from, after: tr.mapping.maps.length, offset };
        }
      }

      if (pastedSource) {
        const mapping = tr.mapping.slice(pastedSource.after);
        beginMarkdownSourceEdit(tr, mapping.map(pastedSource.from, 1), mapping.map(pastedSource.to, -1));
      } else if (active) {
        const pos = tr.mapping.slice(active.after).map(active.pos, -1);
        tr.setSelection(TextSelection.create(tr.doc, pos));
        requestMarkdownSourceEditor(tr, { pos, start: active.offset, end: active.offset });
      }
      if (!tr.docChanged) return null;
      return tr.setMeta(promotionMeta, true);
    },
  });
}
