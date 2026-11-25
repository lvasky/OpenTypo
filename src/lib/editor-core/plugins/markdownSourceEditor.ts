import { Fragment, type ResolvedPos } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { t } from '../../../app/i18n';
import { getInlineMarkdownSource, serializeMarkdown, tryParseMarkdown } from '../markdown';
import { IMAGE_FILE_DELETE_META } from '../nodeViews/ImageNodeView';
import { isActiveEditComposing, registerActiveEdit, unregisterActiveEdit } from '../nodeViews/activeEditRegistry';

interface SourceRange {
  from: number;
  content: Fragment;
  definitionId?: string;
}

interface SourceEditorFocus {
  pos: number;
  start: number;
  end: number;
  side?: -1 | 1;
}

interface SourceState {
  range: SourceRange;
  decorations: DecorationSet;
}

const sourceEditorKey = new PluginKey<SourceState | null>('markdown-source-editor');
const focusSourceEditor = 'focusMarkdownSourceEditor';
const sourceAtomNames = new Set(['image', 'footnote_ref', 'math_inline']);
const hiddenClass = 'pm-markdown-source-hidden';

export function requestMarkdownSourceEditor(tr: Transaction, focus: SourceEditorFocus): void {
  tr.setMeta(focusSourceEditor, focus);
}

function rangeAt($pos: ResolvedPos, preferBefore = false): SourceRange | null {
  const { parent, parentOffset, pos } = $pos;
  if (!parent.isTextblock || parent.type.spec.code || parent.type.name === 'html_block') return null;
  if (parent.type.name === 'footnote_def' && parentOffset === 0) {
    return { from: pos, content: Fragment.empty, definitionId: String(parent.attrs.id) };
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

function sourceText(state: EditorState, range: SourceRange): string {
  if (range.definitionId !== undefined) return `[^${range.definitionId}]:`;
  const { content } = range;
  const first = content.firstChild;
  if (first?.type.name === 'image' && content.childCount === 1 && !first.marks.length) {
    const original = getInlineMarkdownSource(first);
    if (original) return original;
  }
  const link = first?.marks.find((mark) => mark.type.name === 'link');
  const original = link && getInlineMarkdownSource(link);
  if (original && tryParseMarkdown(original)?.firstChild?.content.eq(content)) {
    return original;
  }
  const { doc, paragraph } = state.schema.nodes;
  return serializeMarkdown(doc.create(null, paragraph.create(null, content)));
}

function applySourceEdit(tr: Transaction, from: number, range: SourceRange, source: string): void {
  const { doc } = tr;
  const schema = doc.type.schema;
  const $from = doc.resolve(from);
  if (range.definitionId !== undefined) {
    if ($from.parent.type !== schema.nodes.footnote_def || $from.parent.attrs.id !== range.definitionId) return;
    const match = /^\[\^([^\]\s]+)\]:[ \t]*$/.exec(source);
    if (match) tr.setNodeAttribute($from.before(), 'id', match[1]);
    return;
  }
  const end = from + range.content.size;
  const to = end - $from.start();
  if (to > $from.parent.content.size || !range.content.eq($from.parent.content.cut($from.parentOffset, to))) return;
  const parsed = tryParseMarkdown(source)?.firstChild;
  const replacement = parsed?.type === schema.nodes.paragraph
    ? parsed.content
    : source ? Fragment.from(schema.text(source, [schema.marks.inline_source.create()])) : Fragment.empty;
  const block = $from.parent;
  const next = block.content.cut(0, $from.parentOffset).append(replacement).append(block.content.cut(to));
  if (block.type.validContent(next)) tr.replaceWith(from, end, replacement).setMeta(IMAGE_FILE_DELETE_META, false);
}

function createWrappingSourceField(doc: Document, source: string): HTMLSpanElement {
  const field = doc.createElement('span');
  field.className = 'pm-markdown-source-text';
  field.setAttribute('contenteditable', 'plaintext-only');
  field.setAttribute('role', 'textbox');
  field.tabIndex = -1;
  field.textContent = source;
  field.addEventListener('paste', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData('text/plain');
    const selection = doc.getSelection();
    if (!text || !selection?.rangeCount || !field.contains(selection.anchorNode) || !field.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const inserted = doc.createTextNode(text.replace(/\r\n?/g, '\n'));
    range.deleteContents();
    range.insertNode(inserted);
    selection.collapse(inserted, inserted.length);
  });
  return field;
}

function createSourceField(
  range: SourceRange,
  view: EditorView,
  getPos: () => number | undefined,
  focus: SourceEditorFocus,
) {
  const doc = view.dom.ownerDocument;
  const win = doc.defaultView!;
  const widget = doc.createElement('span');
  widget.className = 'pm-markdown-source-widget';
  const original = sourceText(view.state, range);
  const first = range.content.firstChild;
  const wraps = first?.type.name === 'image' || first?.marks.some((mark) => mark.type.name === 'link');
  const input = wraps ? null : doc.createElement('input');
  const field = input ?? createWrappingSourceField(doc, original);
  if (input) {
    input.type = 'text';
    input.value = original;
    const resize = () => { input.style.inlineSize = `${Math.max(3, Math.min(120, input.value.length + 1))}ch`; };
    resize();
    input.addEventListener('input', resize);
  } else {
    widget.classList.add('pm-markdown-source-wrapping');
  }
  field.spellcheck = false;
  field.setAttribute('aria-label', t.sourceMode());
  widget.append(field);
  const readText = () => input?.value ?? field.textContent ?? '';

  let closed = false;
  let composing = false;
  let compositionEndTimer: number | undefined;
  let compositionDone: Promise<void> = Promise.resolve();
  let finishComposition = () => {};
  let deferred: (() => void) | undefined;
  const finish = (save: boolean, move?: -1 | 1) => {
    if (closed) return;
    if (composing) { deferred = () => finish(save, move); return; }
    closed = true;
    unregisterActiveEdit(view, exit);
    if (view.isDestroyed) return;
    const from = getPos();
    const tr = view.state.tr.setMeta(sourceEditorKey, null);
    const text = readText();
    if (from !== undefined && save && view.editable && text !== original) {
      applySourceEdit(tr, from, range, text);
    }
    if (from !== undefined && move) {
      const end = from + range.content.size;
      const pos = move < 0 ? tr.mapping.map(from, -1) : tr.mapping.map(end, 1);
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos), move));
    }
    if (!tr.docChanged) tr.setMeta('addToHistory', false);
    view.dispatch(tr);
    if (move) view.focus();
  };
  const exit = () => finish(true);
  field.addEventListener('focus', () => registerActiveEdit(view, exit, () => {}, {
    exitOnManualSave: true,
    isComposing: () => composing,
    waitForCompositionEnd: () => compositionDone,
  }));
  field.addEventListener('compositionstart', () => {
    win.clearTimeout(compositionEndTimer);
    if (!composing) compositionDone = new Promise<void>((resolve) => { finishComposition = resolve; });
    composing = true;
  });
  field.addEventListener('compositionend', () => {
    compositionEndTimer = win.setTimeout(() => {
      composing = false;
      finishComposition();
      const finishDeferred = deferred;
      deferred = undefined;
      finishDeferred?.();
    }, 0);
  });
  field.addEventListener('blur', exit);
  field.addEventListener('keydown', (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (!input && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      doc.getSelection()?.selectAllChildren(field);
    } else if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      finish(event.key === 'Enter', 1);
    } else if (!event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      let offset = input?.selectionStart === input?.selectionEnd ? input?.selectionStart : null;
      if (!input) {
        const selection = doc.getSelection();
        if (!selection?.isCollapsed || !selection.anchorNode || !field.contains(selection.anchorNode)) return;
        const before = doc.createRange();
        before.selectNodeContents(field);
        before.setEnd(selection.anchorNode, selection.anchorOffset);
        offset = before.toString().length;
      }
      const side = event.key === 'ArrowLeft' ? -1 : 1;
      if (offset === (side === -1 ? 0 : readText().length)) {
        event.preventDefault();
        finish(true, side);
      }
    }
  });
  const frame = win.requestAnimationFrame(() => {
    if (!widget.isConnected || !view.editable || !view.hasFocus()) return;
    field.focus({ preventScroll: true });
    const start = Math.min(focus.start, original.length);
    const end = Math.min(focus.end, original.length);
    if (input) input.setSelectionRange(start, end);
    else if (field.firstChild) {
      doc.getSelection()?.setBaseAndExtent(field.firstChild, start, field.firstChild, end);
    }
  });
  return { widget, destroy: () => {
    closed = true;
    win.cancelAnimationFrame(frame);
    win.clearTimeout(compositionEndTimer);
    unregisterActiveEdit(view, exit);
    finishComposition();
  } };
}

function decorationsFor(state: EditorState, range: SourceRange, focus: SourceEditorFocus): DecorationSet {
  let destroy: (() => void) | undefined;
  const decorations = [Decoration.widget(range.from, (view, getPos) => {
    const field = createSourceField(range, view, getPos, focus);
    destroy = field.destroy;
    return field.widget;
  }, { side: -1, marks: [], stopEvent: () => true, ignoreSelection: true, destroy: () => destroy?.() })];
  const end = range.from + range.content.size;
  const only = range.content.childCount === 1 && range.content.firstChild;
  if (only && !only.isText) {
    decorations.push(Decoration.node(range.from, end, { class: hiddenClass }));
  } else if (end > range.from) {
    decorations.push(Decoration.inline(range.from, end, { class: hiddenClass }));
  }
  return DecorationSet.create(state.doc, decorations);
}

export function openMarkdownSourceAt(view: EditorView, pos: number, side?: -1 | 1): boolean {
  if (!view.editable || isActiveEditComposing(view)) return false;
  const $pos = view.state.doc.resolve(pos);
  const range = rangeAt($pos, side === 1);
  if (!range) return false;
  const end = range.from + range.content.size;
  if ((side === -1 && pos === end && pos !== range.from) ||
      (side === 1 && pos === range.from && pos !== end)) return false;
  const cursor = pos === range.from ? 0 : pos === end ? Number.MAX_SAFE_INTEGER : pos - range.from + 1;
  const doc = view.state.doc;
  if (!view.hasFocus()) view.focus();
  // Focusing the document can commit a different field that just lost focus.
  if (view.state.doc !== doc) return false;
  const tr = view.state.tr.setSelection(TextSelection.near($pos));
  requestMarkdownSourceEditor(tr, { pos, start: cursor, end: cursor, side });
  view.dispatch(tr.setMeta('addToHistory', false));
  return true;
}

export function markdownSourceEditorPlugin(): Plugin<SourceState | null> {
  return new Plugin<SourceState | null>({
    key: sourceEditorKey,
    state: {
      init: () => null,
      apply(tr, active, _old, state) {
        if (tr.getMeta(sourceEditorKey) === null) return null;
        const focus = tr.getMeta(focusSourceEditor) as SourceEditorFocus | undefined;
        if (focus) {
          const range = rangeAt(state.doc.resolve(focus.pos), focus.side === 1);
          return range ? { range, decorations: decorationsFor(state, range, focus) } : null;
        }
        if (!active || !tr.docChanged) return active;
        const from = tr.mapping.map(active.range.from, -1);
        const range = rangeAt(state.doc.resolve(from));
        return range && range.from === from && range.definitionId === active.range.definitionId &&
          range.content.eq(active.range.content)
          ? { range, decorations: active.decorations.map(tr.mapping, tr.doc) } : null;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations;
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
    },
    view(view) {
      // Footnote buttons own their normal mouse events. Ordinary clicks edit
      // their source; Ctrl/Cmd-click still follows the reference.
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
