import { Fragment, type Node as ProseMirrorNode, type ResolvedPos } from 'prosemirror-model';
import { isHistoryTransaction } from 'prosemirror-history';
import { AllSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { analyzeInlineSource, isInlineSourceBlock } from '../InlineSourceCodec';
import { serializeMarkdown, tryParseMarkdown } from '../markdown';
import { getInlineMarkdownSource, retainInlineMarkdownSpelling } from '../inlineMarkdownSpelling';
import { IMAGE_FILE_DELETE_META } from '../nodeViews/ImageNodeView';
import { FootnoteRefNodeView } from '../nodeViews/FootnoteRefNodeView';
import { isInlineSourceComposing } from './inlineSourceEditing';

interface SourceRange {
  from: number;
  content: Fragment;
  definition?: ProseMirrorNode;
}

interface SourceEditorFocus {
  pos: number;
  start: number;
  end: number;
  side?: -1 | 1;
}

interface SourceEdit {
  from: number;
  to: number;
  original?: SourceRange;
  changed: boolean;
}

const sourceEditorKey = new PluginKey<SourceEdit | null>('markdown-source-editor');
const sourceProjection = 'markdownSourceProjection';
const finishSourceEdit = 'finishMarkdownSourceEdit';
const sourceAtomNames = new Set(['image', 'footnote_ref', 'math_inline']);

export function isMarkdownSourceProjection(tr: Transaction): boolean {
  return tr.getMeta(sourceProjection) === true;
}

export function getMarkdownSourceEdit(state: EditorState): { from: number; to: number } | null {
  return sourceEditorKey.getState(state) ?? null;
}

export function isEditingMarkdownSource(state: EditorState): boolean {
  const edit = sourceEditorKey.getState(state);
  return !!edit && selectionInEdit(state, edit);
}

export function commitMarkdownSourceEdit(view: EditorView): void {
  if (sourceEditorKey.getState(view.state) && !isInlineSourceComposing(view)) {
    view.dispatch(view.state.tr.setMeta(finishSourceEdit, true));
  }
}

function editingMark(state: EditorState) {
  return state.schema.marks.inline_source.create({ literal: true, verbatim: true });
}

export function beginMarkdownSourceEdit(tr: Transaction, from: number, to: number): void {
  if (to <= from) return;
  const inlineSource = tr.doc.type.schema.marks.inline_source;
  const mark = inlineSource.create({ literal: true, verbatim: true });
  tr.removeMark(from, to, inlineSource).addMark(from, to, mark);
  tr.setMeta(sourceEditorKey, { from, to, changed: true } satisfies SourceEdit);
  if (tr.selection.empty) tr.setStoredMarks([mark]);
}

function rangeAt($pos: ResolvedPos, preferBefore = false): SourceRange | null {
  const { parent, parentOffset, pos } = $pos;
  if (!parent.isTextblock || parent.type.spec.code || parent.type.name === 'html_block') return null;
  if (parent.type.name === 'footnote_def') {
    return { from: $pos.start(), content: parent.content, definition: parent };
  }
  const { nodeBefore, nodeAfter } = $pos;
  const firstAtom = preferBefore ? nodeBefore : nodeAfter;
  if (firstAtom && sourceAtomNames.has(firstAtom.type.name)) {
    return { from: preferBefore ? pos - firstAtom.nodeSize : pos, content: Fragment.from(firstAtom) };
  }
  let index = $pos.index();
  const link = (child: number) => parent.maybeChild(child)?.marks.find(
    (mark) => mark.type.name === 'link' && !mark.attrs.html,
  );
  if (index > 0 && !$pos.textOffset && (preferBefore || !link(index))) index--;
  const mark = link(index);
  if (mark) {
    let first = index;
    let last = index;
    while (first > 0 && link(first - 1)?.eq(mark)) first--;
    while (last + 1 < parent.childCount && link(last + 1)?.eq(mark)) last++;
    const start = $pos.posAtIndex(first);
    const end = $pos.posAtIndex(last + 1);
    return { from: start, content: parent.content.cut(start - $pos.start(), end - $pos.start()) };
  }
  const secondAtom = preferBefore ? nodeAfter : nodeBefore;
  if (secondAtom && sourceAtomNames.has(secondAtom.type.name)) {
    return { from: preferBefore ? pos : pos - secondAtom.nodeSize, content: Fragment.from(secondAtom) };
  }
  return null;
}

function sourceText(parentDoc: ProseMirrorNode, range: SourceRange): string {
  const { schema } = parentDoc.type;
  if (range.definition) return serializeMarkdown(schema.nodes.doc.create(null, range.definition));
  const { content } = range;
  const first = content.firstChild;
  if ((first?.type.name === 'image' || first?.type.name === 'footnote_ref') &&
      content.childCount === 1 && !first.marks.length) {
    const original = getInlineMarkdownSource(first);
    if (original) return original;
  }
  const link = first?.marks.find((mark) => mark.type.name === 'link');
  const original = link && getInlineMarkdownSource(link);
  if (original && tryParseMarkdown(original)?.firstChild?.content.eq(content)) {
    return original;
  }
  const { doc, paragraph } = schema.nodes;
  return serializeMarkdown(doc.create(null, paragraph.create(null, content)));
}

export function requestMarkdownSourceEditor(tr: Transaction, focus: SourceEditorFocus): boolean {
  const range = rangeAt(tr.doc.resolve(focus.pos), focus.side === 1);
  if (!range) return false;
  const source = sourceText(tr.doc, range);
  if (!source) return false;

  const { schema } = tr.doc.type;
  const { from } = range;
  const mark = schema.marks.inline_source.create({ literal: true, verbatim: true });
  const text = schema.text(source, [mark]);
  if (range.definition) {
    tr.replaceWith(from - 1, from + range.content.size + 1, schema.nodes.paragraph.create(null, text));
  } else {
    tr.replaceWith(from, from + range.content.size, text);
  }
  const to = from + source.length;
  const start = Math.max(0, Math.min(focus.start, source.length));
  const end = Math.max(start, Math.min(focus.end, source.length));
  tr.setSelection(TextSelection.create(tr.doc, from + start, from + end));
  tr.setMeta(sourceEditorKey, { from, to, original: range, changed: false } satisfies SourceEdit);
  tr.setMeta(IMAGE_FILE_DELETE_META, false);
  if (start === end) tr.setStoredMarks([mark]);
  return true;
}

function selectionInEdit(state: EditorState, edit: SourceEdit): boolean {
  if (state.selection instanceof AllSelection) return false;
  const { from, to, empty } = state.selection;
  return empty ? from >= edit.from && from <= edit.to : from < edit.to && to > edit.from;
}

function renderEditedSource(
  tr: Transaction,
  from: number,
  to: number,
  original: SourceRange | undefined,
  changed: boolean,
): boolean {
  const $from = tr.doc.resolve(from);
  const $to = tr.doc.resolve(to);
  const { schema } = tr.doc.type;
  const source = tr.doc.textBetween(from, to, '', (node) => node.type === schema.nodes.hard_break ? '\n' : '\ufffc');
  const inCode = analyzeInlineSource($from.parent).spans.some((span) =>
    span.type === 'code' && $from.parentOffset < span.closeTo && $to.parentOffset > span.openFrom);
  if (inCode) return false;

  const parsed = changed && source ? tryParseMarkdown(source) : null;
  const parsedBlock = parsed?.childCount === 1 ? parsed.firstChild : null;
  const definition = changed ? parsedBlock : original?.definition;
  if (definition?.type === schema.nodes.footnote_def && from === $from.start() && to === $from.end() &&
      $from.node(-1).canReplaceWith($from.index(-1), $from.index(-1) + 1, definition.type)) {
    retainInlineMarkdownSpelling(definition.content);
    if (!changed || serializeMarkdown(schema.nodes.doc.create(null, definition)) === source) {
      tr.replaceWith($from.before(), $from.after(), definition);
      return true;
    }
  }

  let fragment = original?.definition ? undefined : original?.content;
  if (changed) fragment = parsedBlock?.type === schema.nodes.paragraph ? parsedBlock.content : undefined;
  if (!fragment || !$from.parent.type.validContent(
    $from.parent.content.cut(0, $from.parentOffset).append(fragment).append($from.parent.content.cut($to.parentOffset)),
  )) return false;
  if (changed) {
    retainInlineMarkdownSpelling(fragment);
    // Leave malformed fragments and their original whitespace in the document.
    if (!parsedBlock?.children.some((node) => !node.isText || node.marks.some((mark) =>
      mark.type !== schema.marks.inline_source)) ||
      serializeMarkdown(schema.nodes.doc.create(null, parsedBlock)) !== source) return false;
  }
  tr.replaceWith(from, to, fragment);
  return true;
}

function finishEdit(state: EditorState, edit: SourceEdit): Transaction {
  const tr = state.tr.setMeta(sourceEditorKey, null).setMeta(sourceProjection, true)
    .setMeta(IMAGE_FILE_DELETE_META, false);
  if (!edit.changed) tr.setMeta('addToHistory', false);
  const { from, to } = edit;
  const segments: Array<{ from: number; to: number }> = [];
  if (from < to) {
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      const start = Math.max(from, pos + 1);
      const end = Math.min(to, pos + node.nodeSize - 1);
      if (start < end && isInlineSourceBlock(node)) segments.push({ from: start, to: end });
      return false;
    });
  }
  // Reparse each affected paragraph independently so a real Enter stays a real paragraph break.
  for (const segment of segments.reverse()) {
    if (renderEditedSource(tr, segment.from, segment.to, edit.original, edit.changed)) continue;
    tr.removeMark(segment.from, segment.to, editingMark(state));
    tr.addMark(segment.from, segment.to, state.schema.marks.inline_source.create({ verbatim: true }));
  }
  return tr.removeStoredMark(state.schema.marks.inline_source);
}

function restoredSourceEdit(state: EditorState, transactions: readonly Transaction[]): SourceEdit | null {
  const change = transactions.find(isHistoryTransaction)?.changedRange();
  if (!change) return null;
  const from = Math.min(change.from, state.doc.content.size);
  const to = Math.min(change.to, state.doc.content.size);
  const mark = editingMark(state);
  let range: SourceEdit | null = null;
  state.doc.nodesBetween(Math.max(0, from - 1), Math.min(to + 1, state.doc.content.size), (node, pos) => {
    if (!node.isText || !mark.isInSet(node.marks)) return;
    range = { from: range?.from ?? pos, to: pos + node.nodeSize, changed: true };
  });
  return range;
}

export function openMarkdownSourceAt(view: EditorView, pos: number, side?: -1 | 1): boolean {
  if (!view.editable || isInlineSourceComposing(view)) return false;
  const active = sourceEditorKey.getState(view.state);
  if (active && pos >= active.from && pos <= active.to) {
    // Arrow keys can leave an entire range even when it occupies the full paragraph.
    if ((side === -1 && pos === active.to) || (side === 1 && pos === active.from)) {
      commitMarkdownSourceEdit(view);
      return true;
    }
    return false;
  }
  const { state } = view;
  const $pos = state.doc.resolve(pos);
  const range = rangeAt($pos, side === 1);
  if (!range) return false;
  const end = range.from + range.content.size;
  if ((side === -1 && pos === end && pos !== range.from) ||
      (side === 1 && pos === range.from && pos !== end)) return false;
  if (active) {
    const close = finishEdit(state, active);
    const mapped = close.mapping.map(pos, side ?? 1);
    view.dispatch(close);
    return openMarkdownSourceAt(view, mapped, side);
  }
  const prefixLength = range.definition
    ? String(range.definition.attrs.sourcePrefix ?? `[^${range.definition.attrs.id}]: `).length
    : 1;
  const cursor = pos === range.from ? 0 : pos === end ? Number.MAX_SAFE_INTEGER : pos - range.from + prefixLength;
  const tr = state.tr.setMeta('addToHistory', false).setMeta(sourceProjection, true);
  if (!requestMarkdownSourceEditor(tr, { pos, start: cursor, end: cursor, side })) return false;
  if (range.definition || range.content.firstChild?.type.name === 'footnote_ref') FootnoteRefNodeView.closePreviews(view);
  view.dispatch(tr);
  if (!view.hasFocus()) view.focus();
  return true;
}

export function markdownSourceEditorPlugin(): Plugin<SourceEdit | null> {
  return new Plugin<SourceEdit | null>({
    key: sourceEditorKey,
    state: {
      init: () => null,
      apply(tr, active) {
        const requested = tr.getMeta(sourceEditorKey) as SourceEdit | null | undefined;
        if (requested !== undefined) return requested;
        if (!active || !tr.docChanged) return active;
        const from = tr.mapping.map(active.from, -1);
        const to = tr.mapping.map(active.to, 1);
        const range = tr.changedRange();
        const changed = active.changed || !!range && range.from <= to && range.to >= from;
        return { ...active, from, to, changed };
      },
    },
    appendTransaction(transactions, _old, state) {
      const active = sourceEditorKey.getState(state) ?? restoredSourceEdit(state, transactions);
      if (!active || isInlineSourceComposing(state)) return null;
      // Keep the representation change in the undo/redo operation that restored the text.
      if (transactions.some((tr) => isHistoryTransaction(tr) || tr.getMeta(finishSourceEdit)) || !selectionInEdit(state, active)) {
        return finishEdit(state, active);
      }
      return null;
    },
    props: {
      decorations(state) {
        const range = sourceEditorKey.getState(state);
        return range && range.from < range.to
          ? DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: 'pm-markdown-source-text' })])
          : null;
      },
      handleClick(view, pos, event) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
        return openMarkdownSourceAt(view, pos);
      },
      handleKeyDown(view, event) {
        if (!view.state.selection.empty || event.shiftKey || event.altKey || event.ctrlKey ||
            event.metaKey || event.isComposing || view.composing) return false;
        if (event.key === 'ArrowRight') return openMarkdownSourceAt(view, view.state.selection.from, -1);
        if (event.key === 'ArrowLeft') return openMarkdownSourceAt(view, view.state.selection.from, 1);
        return false;
      },
      handleDOMEvents: {
        blur(view, event) {
          if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.context-menu')) return false;
          if (view.state.selection.empty) commitMarkdownSourceEdit(view);
          return false;
        },
      },
    },
    view(view) {
      // The footnote buttons still own clicks while rendered.
      const onMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
            !(event.target instanceof Element)) return;
        const target = event.target.closest('.footnote-ref, .footnote-def-marker');
        if (!target) return;
        const dom = target.classList.contains('footnote-def-marker')
          ? target.parentElement?.querySelector('.footnote-def-content') : target;
        if (dom && openMarkdownSourceAt(view, view.posAtDOM(dom, 0))) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      view.dom.addEventListener('mousedown', onMouseDown, true);
      return { destroy: () => view.dom.removeEventListener('mousedown', onMouseDown, true) };
    },
  });
}
