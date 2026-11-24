import { Fragment, type ResolvedPos } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { t } from '../../../app/i18n';
import { serializeMarkdown, tryParseMarkdown } from '../markdown';
import { IMAGE_FILE_DELETE_META } from '../nodeViews/ImageNodeView';
import { registerActiveEdit, unregisterActiveEdit } from '../nodeViews/activeEditRegistry';

interface SourceRange {
  from: number;
  content: Fragment;
  definitionId?: string;
}

interface SourceState {
  hovered: number | null;
  range: SourceRange | null;
  decorations: DecorationSet;
}

const sourceEditorKey = new PluginKey<SourceState>('markdown-source-editor');

function rangeAt($pos: ResolvedPos, hover: boolean): SourceRange | null {
  const { parent, parentOffset, pos } = $pos;
  if (!parent.isTextblock || parent.type.spec.code || parent.type.name === 'html_block') return null;
  if (parent.type.name === 'footnote_def' && parentOffset === 0) {
    return { from: pos, content: Fragment.empty, definitionId: String(parent.attrs.id) };
  }
  const after = $pos.nodeAfter;
  if (after?.type.name === 'image' || after?.type.name === 'footnote_ref') {
    return { from: pos, content: Fragment.from(after) };
  }
  // Check full children so that placing the caret inside a link works as well
  // as reaching the edge with the arrow keys.
  let index = $pos.index();
  const link = (child: number) => parent.maybeChild(child)?.marks.find(
    (mark) => mark.type.name === 'link' && !mark.attrs.html,
  );
  if (!hover && !link(index) && index > 0) index--;
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
  const before = $pos.nodeBefore;
  if (!hover && (before?.type.name === 'image' || before?.type.name === 'footnote_ref')) {
    return { from: pos - before.nodeSize, content: Fragment.from(before) };
  }
  return null;
}

function sourceText(state: EditorState, range: SourceRange): string {
  if (range.definitionId !== undefined) return `[^${range.definitionId}]:`;
  let content = range.content;
  const image = content.firstChild;
  if (image?.type.name === 'image' && content.childCount === 1 && !image.marks.length) {
    // The source field edits Markdown image syntax. Keep image layout properties
    // on the node, including those normally saved through an HTML wrapper.
    content = Fragment.from(image.type.create({ ...image.attrs, align: null, width: null }));
  }
  const { doc, paragraph } = state.schema.nodes;
  return serializeMarkdown(doc.create(null, paragraph.create(null, content)));
}

function createSourceField(range: SourceRange, view: EditorView, getPos: () => number | undefined) {
  const widget = document.createElement('span');
  widget.className = 'pm-markdown-source-widget';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.setAttribute('aria-label', t.sourceMode());
  const original = sourceText(view.state, range);
  input.value = original;
  widget.append(input);
  const positionFrame = requestAnimationFrame(() => {
    if (!widget.isConnected) return;
    const bounds = (view.dom.closest('.semantic-pane') ?? view.dom).getBoundingClientRect();
    const anchor = widget.getBoundingClientRect();
    const width = Math.max(0, Math.min(448, bounds.width - 16));
    input.style.inlineSize = `${width}px`;
    const left = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - width - 8));
    input.style.insetInlineStart = `${left - anchor.left}px`;
    if (anchor.top < bounds.top + 54) widget.classList.add('is-below');
  });
  let composing = false;
  let compositionDone: Promise<void> = Promise.resolve();
  let finishComposition = () => {};
  let pendingBlur = false;

  const commit = () => {
    if (!view.editable || view.isDestroyed || input.value === original) return;
    const from = getPos();
    if (from === undefined) return;
    const { doc, schema } = view.state;
    const $from = doc.resolve(from);
    if (range.definitionId !== undefined) {
      if ($from.parent.type !== schema.nodes.footnote_def || $from.parent.attrs.id !== range.definitionId) return;
      const match = /^\[\^([^\]\s]+)\]:[ \t]*$/.exec(input.value);
      if (match) view.dispatch(view.state.tr.setNodeAttribute($from.before(), 'id', match[1]));
      else input.value = original;
      return;
    }
    const end = from + range.content.size;
    const to = end - $from.start();
    if (to > $from.parent.content.size || !range.content.eq($from.parent.content.cut($from.parentOffset, to))) return;
    const parsed = tryParseMarkdown(input.value)?.firstChild;
    let replacement = parsed?.type === schema.nodes.paragraph
      ? parsed.content
      : input.value ? Fragment.from(schema.text(input.value, [schema.marks.inline_source.create()])) : Fragment.empty;
    const oldImage = range.content.firstChild;
    const newImage = replacement.firstChild;
    if (replacement.childCount === 1 && newImage?.type === schema.nodes.image &&
        range.content.childCount === 1 && oldImage?.type === schema.nodes.image) {
      replacement = Fragment.from(newImage.type.create(
        { ...newImage.attrs, align: oldImage.attrs.align, width: oldImage.attrs.width },
        null,
        newImage.marks,
      ));
    }
    if ($from.parent.canReplace($from.index(), doc.resolve(end).index(), replacement)) {
      view.dispatch(view.state.tr.replaceWith(from, end, replacement).setMeta(IMAGE_FILE_DELETE_META, false));
    }
  };
  const exit = () => {
    if (composing) { pendingBlur = true; return; }
    unregisterActiveEdit(view, exit);
    commit();
  };
  input.addEventListener('focus', () => {
    registerActiveEdit(view, exit, () => {}, {
      exitOnManualSave: true,
      isComposing: () => composing,
      waitForCompositionEnd: () => compositionDone,
    });
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
    compositionDone = new Promise<void>((resolve) => { finishComposition = resolve; });
  });
  input.addEventListener('compositionend', () => queueMicrotask(() => {
    composing = false;
    finishComposition();
    if (pendingBlur) {
      pendingBlur = false;
      exit();
    }
  }));
  input.addEventListener('blur', exit);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || composing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
    event.preventDefault();
    if (event.key === 'Escape') input.value = original;
    input.blur();
    view.focus();
  });
  // Widget destruction can remove a focused element without a blur event.
  return { widget, destroy: () => {
    cancelAnimationFrame(positionFrame);
    unregisterActiveEdit(view, exit);
    finishComposition();
  } };
}

export function markdownSourceEditorPlugin(): Plugin<SourceState> {
  return new Plugin<SourceState>({
    key: sourceEditorKey,
    state: {
      init: () => ({ hovered: null, range: null, decorations: DecorationSet.empty }),
      apply(tr, previous, _old, state) {
        const hover = tr.getMeta(sourceEditorKey) as { pos: number | null } | undefined;
        if (!hover && !tr.docChanged && !tr.selectionSet) return previous;
        const hovered = hover ? hover.pos
          : tr.selectionSet || previous.hovered === null ? null
          : tr.mapping.map(previous.hovered);
        const range = hovered !== null ? rangeAt(state.doc.resolve(hovered), true)
          : state.selection.empty || (state.selection instanceof NodeSelection && state.selection.node.type.name === 'image')
            ? rangeAt(state.selection.$from, false) : null;
        if (range && previous.range?.from === range.from &&
            previous.range.definitionId === range.definitionId && previous.range.content.eq(range.content)) {
          return { ...previous, hovered };
        }
        let decorations = DecorationSet.empty;
        if (range) {
          let destroy: (() => void) | undefined;
          decorations = DecorationSet.create(state.doc, [Decoration.widget(range.from, (view, getPos) => {
            const field = createSourceField(range, view, getPos);
            destroy = field.destroy;
            return field.widget;
          }, { side: -1, stopEvent: () => true, ignoreSelection: true, destroy: () => destroy?.() })]);
        }
        return { hovered, range, decorations };
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations;
      },
    },
    view(view) {
      const fieldIsFocused = () => Boolean(view.dom.ownerDocument.activeElement?.closest('.pm-markdown-source-widget'));
      let hideTimer: number | undefined;
      const onMouseOver = (event: MouseEvent) => {
        window.clearTimeout(hideTimer);
        if (!view.editable || fieldIsFocused()) return;
        if (!(event.target instanceof Element) || event.target.closest('.pm-markdown-source-widget')) return;
        const target = event.ctrlKey || event.metaKey ? null :
          event.target.closest('.image-node, .footnote-ref, .footnote-def-marker, a[href]');
        const dom = target?.classList.contains('footnote-def-marker')
          ? target.parentElement?.querySelector('.footnote-def-content') : target;
        const pos = dom && view.dom.contains(dom) ? view.posAtDOM(dom, 0) : null;
        if (pos !== null) setHover(pos);
        else hideTimer = window.setTimeout(() => setHover(null), 180);
      };
      const setHover = (pos: number | null) => {
        if (sourceEditorKey.getState(view.state)?.hovered !== pos) {
          view.dispatch(view.state.tr.setMeta(sourceEditorKey, { pos }));
        }
      };
      const onMouseLeave = () => {
        if (!fieldIsFocused()) setHover(null);
      };
      view.dom.addEventListener('mouseover', onMouseOver);
      view.dom.addEventListener('mouseleave', onMouseLeave);
      return {
        destroy() {
          window.clearTimeout(hideTimer);
          view.dom.removeEventListener('mouseover', onMouseOver);
          view.dom.removeEventListener('mouseleave', onMouseLeave);
        },
      };
    },
  });
}
