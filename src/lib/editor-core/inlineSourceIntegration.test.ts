import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { createEditorCore } from './createEditorCore';
import { projectInlineSource } from './InlineSourceCodec';
import { setTypographyOptions } from '../typography/options';
import { DEFAULT_TYPOGRAPHY } from '../typography/types';
import { schema } from './schema';
import { parseMarkdown } from './markdown';
import { QUICK_INSERT_CATEGORIES } from './quickInsert';
import { inlineSourceEditingPluginKey } from './plugins/inlineSourceEditing';

beforeEach(() => setTypographyOptions({ ...DEFAULT_TYPOGRAPHY, enabled: false }));
afterEach(() => {
  setTypographyOptions(DEFAULT_TYPOGRAPHY);
  vi.useRealTimers();
});

function setup(markdown: string) {
  const target = document.createElement('div');
  document.body.append(target);
  const editor = createEditorCore({ markdown, target });
  const view = (editor as unknown as { view: EditorView }).view;
  return {
    editor,
    view,
    target,
    destroy: () => {
      editor.destroy();
      target.remove();
    },
  };
}

describe('inline source editor integration', () => {
  it.each([
    ['[aa](bb)', 'a[href="bb"]'],
    ['![aa](bb)', '.image-node'],
    ['[^1]', '.footnote-ref'],
    ['$x$', '.math-inline'],
  ])('shows %s as literal code when wrapping existing syntax in backticks', (source, selector) => {
    const { editor, view, target, destroy } = setup(source);
    try {
      expect(target.querySelector(selector)).not.toBeNull();
      const tr = view.state.tr.insertText('`', view.state.doc.firstChild!.nodeSize - 1).insertText('`', 1);
      view.dispatch(tr);
      expect(target.querySelector(selector)).toBeNull();
      expect(projectInlineSource(view.state.doc).textContent).toBe(source);
      expect(editor.flushMarkdown()).toBe('`' + source + '`');
    } finally {
      destroy();
    }
  });

  it('does not render Markdown syntax typed between backticks', () => {
    const { editor, view, target, destroy } = setup('');
    const source = '`[aa](bb) ![img](file.png) [^1] $x$`';
    try {
      for (const char of source) view.dispatch(view.state.tr.insertText(char));
      expect(target.querySelector('a, .image-node, .footnote-ref, .math-inline')).toBeNull();
      expect(editor.flushMarkdown()).toBe(source);
    } finally {
      destroy();
    }
  });

  it('renders a completed link in the middle of a paragraph without rewriting other blocks', () => {
    const beforeCaret = '打开 [scurve](./scurve';
    const source = '原有标题\n========\n\n' + beforeCaret + ' 后继续输入';
    const { editor, view, target, destroy } = setup(source);

    try {
      const pos = view.state.doc.child(0).nodeSize + 1 + beforeCaret.length;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
      view.dispatch(view.state.tr.insertText(')'));
      expect(target.querySelector('a[href="./scurve"]')?.textContent).toBe('scurve');
      expect(view.state.selection.$from.parentOffset).toBe('打开 scurve'.length);
      expect(editor.flushMarkdown()).toBe(source.replace('./scurve', './scurve)'));
    } finally {
      destroy();
    }
  });

  it.each([
    ['[label](./a)', 'label', '[label](./b)', 'a[href="./b"]'],
    ['![image](./a.png)', 'image', '![image](./b.png)', '.image-node'],
    ['note [^1]', 'footnote_ref', '[^2]', '.footnote-ref[data-footnote-id="2"]'],
    ['[^1]: definition', 'footnote_def', '[^2]: updated definition', '.footnote-def[data-footnote-id="2"]'],
    ['before $x$ after', 'math_inline', '$x^2$', '.math-inline[data-tex="x^2"]'],
  ])('reveals and edits the source for %s at the caret', async (source, targetText, replacement, selector) => {
    const { editor, view, target, destroy } = setup(source);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      let pos = 0;
      view.state.doc.descendants((node, at) => {
        if (node.isText && node.text === targetText) pos = at + 1;
        if (node.type.name === targetText || (targetText === 'image' && node.type.name === 'image')) {
          pos = node.isTextblock ? at + 1 : at;
        }
      });
      view.focus();
      expect(view.someProp('handleClick', (handler) => handler(view, pos, new MouseEvent('click')))).toBe(true);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const field = target.querySelector<HTMLElement>('.pm-markdown-source-widget > :first-child');
      expect(document.activeElement).toBe(field);
      expect(field?.closest('.ProseMirror')).toBe(view.dom);
      expect(target.querySelector('.pm-markdown-source-hidden')).not.toBeNull();
      if (field instanceof HTMLInputElement) field.value = replacement;
      else field!.textContent = replacement;
      field!.blur();
      expect(target.querySelector('.pm-markdown-source-widget')).toBeNull();
      expect(target.querySelector(selector)).not.toBeNull();
      expect(editor.flushMarkdown()).toContain(replacement);
    } finally {
      destroy();
    }
  });

  it.each([
    `![image](./${'long-image-path-'.repeat(20)}.png 'caption'){width=420 align=center}`,
    `[link](<./${'long link path '.repeat(20)}target> 'title')`,
    `[^${'footnote-id-'.repeat(20)}]`,
    `[^id]:  ${'Full **footnote** definition. '.repeat(12).trimEnd()}`,
  ])('reveals the full inline source and keeps the original spelling on blur', async (source) => {
    const { editor, view, target, destroy } = setup(source);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      view.focus();
      expect(view.someProp('handleClick', (handler) => handler(view, 1, new MouseEvent('click')))).toBe(true);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const field = target.querySelector<HTMLElement>('.pm-markdown-source-text');
      expect(field?.textContent).toBe(source);
      expect(field?.getAttribute('contenteditable')).toBe('plaintext-only');
      field!.blur();
      expect(editor.flushMarkdown()).toBe(source);
    } finally {
      destroy();
    }
  });

  it.each([
    ["[name](<./link> 'title')", 'a[href="./link"]'],
    ["![image](<./img.png> 'caption')", '.image-node'],
    ['[^long-id]', '.footnote-ref'],
    ['[^long-id]:  A footnote', '.footnote-def'],
  ])('recognizes a multi-character insertion of %s without rewriting its source', (source, selector) => {
    const { editor, view, target, destroy } = setup('');
    try {
      view.dispatch(view.state.tr.insertText(source));
      expect(target.querySelector(selector)).not.toBeNull();
      expect(editor.flushMarkdown()).toBe(source);
      expect(editor.execute({ type: 'undo' })).toBe(true);
      expect(editor.flushMarkdown()).toBe('');
      expect(editor.execute({ type: 'redo' })).toBe(true);
      expect(target.querySelector(selector)).not.toBeNull();
      expect(editor.flushMarkdown()).toBe(source);
    } finally {
      destroy();
    }
  });

  it.each([
    ['[name](./li nk)', 'a[href="./link"]'],
    ['![image](./ima ge.png)', '.image-node'],
    ['[^foot note]', '.footnote-ref'],
  ])('recognizes %s after a deletion and reveals the source while the caret is inside', async (source, selector) => {
    const { editor, view, target, destroy } = setup(source);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const from = source.indexOf(' ') + 1;
      const tr = view.state.tr.delete(from, from + 1);
      view.focus();
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from)));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const field = target.querySelector<HTMLElement>('.pm-markdown-source-text')!;
      expect(document.activeElement).toBe(field);
      expect(field.textContent).toBe(source.replace(' ', ''));
      field.blur();
      expect(target.querySelector(selector)).not.toBeNull();
      expect(editor.flushMarkdown()).toBe(source.replace(' ', ''));
    } finally {
      destroy();
    }
  });

  it('recognizes Markdown on IME commit and preserves escapes and inline code', () => {
    const { view, target, destroy } = setup('');
    try {
      view.dispatch(view.state.tr.setMeta(inlineSourceEditingPluginKey, { composing: true }));
      view.dispatch(view.state.tr.insertText('[有效](./ok) `[代码](./code)` \\[转义](./literal)'));
      expect(target.querySelector('a[href="./ok"]')).toBeNull();
      view.dispatch(view.state.tr.setMeta(inlineSourceEditingPluginKey, { composing: false }));
      expect(Array.from(target.querySelectorAll('.ProseMirror a')).map((link) => link.textContent)).toEqual(['有效']);
    } finally {
      destroy();
    }
  });

  it.each([
    ['image', '![image title](image-path)', '![New image](./pic.png)'],
    ['link', '[link name](link-path)', '[New link](./target)'],
    ['footnote', '[^1]\n\n[^1]:', null],
  ] as const)('inserts %s from the quick menu at the trigger', async (id, template, updated) => {
    const { editor, view, target, destroy } = setup('');
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      view.focus();
      expect(view.someProp('handleTextInput', (handle) =>
        handle(view, 1, 1, '/', () => view.state.tr.insertText('/')))).toBe(true);

      const categories = QUICK_INSERT_CATEGORIES.map((category) => category.id);
      expect(categories.filter((category) => ['emoji', 'comment', 'details'].includes(category))).toEqual([]);
      const options = document.querySelectorAll<HTMLButtonElement>('.quick-insert-menu:not([hidden]) .quick-insert-option');
      options[categories.indexOf(id)].click();
      expect(editor.getMarkdown()).toBe(template);

      if (updated) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const field = target.querySelector<HTMLElement>('.pm-markdown-source-text');
        expect(document.activeElement).toBe(field);
        expect(field?.textContent).toBe(template);
        expect(document.getSelection()?.toString()).toBe(id === 'image' ? 'image title' : 'link name');
        field!.textContent = updated;
        field!.blur();
        expect(editor.getMarkdown()).toBe(updated);
      } else {
        expect(view.state.selection.$from.parent.type.name).toBe('footnote_def');
      }
    } finally {
      destroy();
    }
  });

  it('retains every delimiter caret position and deletes just one asterisk', () => {
    const { editor, view, destroy } = setup('**正文**');
    for (let position = 1; position <= 7; position++) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
      expect(view.state.selection.from).toBe(position);
      let intercepted = false;
      view.someProp('handleKeyDown', (handler) => {
        intercepted ||= Boolean(handler(view, new KeyboardEvent('keydown', { key: 'ArrowRight' })));
        return intercepted;
      });
      expect(intercepted).toBe(false);
    }
    view.dispatch(view.state.tr.delete(1, 2));
    expect(editor.flushMarkdown()).toBe('*正文**');
    expect(editor.execute({ type: 'undo' })).toBe(true);
    expect(editor.flushMarkdown()).toBe('**正文**');
    destroy();
  });

  it('changes only decorations when a different block becomes active', () => {
    const { editor, view, target, destroy } = setup('**甲**\n\n__乙__');
    const original = view.state.doc;
    let dirty = false;
    let revision = 0;
    editor.subscribe((event) => {
      dirty = event.dirty;
      revision = event.contentRevision ?? 0;
    });
    const originalRevision = revision;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)));
    expect(view.state.doc).toBe(original);
    expect(revision).toBe(originalRevision);
    expect(dirty).toBe(false);
    expect(target.querySelectorAll('.pm-inline-source-marker.is-hidden')).toHaveLength(2);
    destroy();
  });

  it('reveals only the current format inside one paragraph and hides all while in plain text', () => {
    const source = '**甲** 普通 __乙__';
    const { editor, view, target, destroy } = setup(source);
    const original = view.state.doc;
    const visibleMarkers = () =>
      Array.from(target.querySelectorAll('.pm-inline-source-marker:not(.is-hidden)')).map(
        (element) => element.textContent,
      );
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(visibleMarkers()).toEqual(['**', '**']);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)));
    expect(visibleMarkers()).toEqual([]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 12)));
    expect(visibleMarkers()).toEqual(['__', '__']);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 15)));
    expect(visibleMarkers()).toEqual(['**', '**', '__', '__']);
    expect(view.state.doc).toBe(original);
    expect(editor.getMarkdown()).toBe(source);
    destroy();
  });

  it('serializes empty pairs safely and cleans only untouched generated templates on flush', () => {
    const { editor, view, destroy } = setup('');
    editor.execute({ type: 'toggleBold' });
    expect(view.state.doc.textContent).toBe('****');
    const templateDoc = view.state.doc;
    // 裸露的 **** 会被 Markdown 解析为分隔线；转义只属于输出，不应改写编辑中的模板。
    const markdown = editor.getMarkdown();
    expect(markdown).toBe('\\****');
    const reopened = projectInlineSource(parseMarkdown(markdown));
    expect(reopened.childCount).toBe(1);
    expect(reopened.firstChild?.type.name).toBe('paragraph');
    expect(reopened.textContent).toBe('****');
    expect(view.state.doc).toBe(templateDoc);
    expect(view.state.selection).toMatchObject({ anchor: 3, head: 3 });
    expect(editor.flushMarkdown()).toBe('');
    expect(view.state.doc.textContent).toBe('');
    editor.execute({ type: 'toggleItalic' });
    view.dispatch(view.state.tr.insertText('x'));
    view.dispatch(view.state.tr.delete(2, 3));
    // An edited-then-emptied pair is user content, never an untouched template.
    expect(editor.flushMarkdown()).toBe('**');
    expect(view.state.doc.textContent).toBe('**');
    destroy();
  });

  it('awaits composition before cleaning and serializing an empty template', async () => {
    const { editor, view, destroy } = setup('');
    editor.execute({ type: 'toggleBold' });
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    let finished = false;
    const pending = editor.awaitCompositionEnd!().then(() => {
      finished = true;
    });
    editor.commitPendingEdits();
    expect(view.state.doc.textContent).toBe('****');
    await Promise.resolve();
    expect(finished).toBe(false);
    view.dispatch(view.state.tr.insertText('中文'));
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    await pending;
    expect(editor.flushMarkdown()).toBe('**中文**');
    destroy();
  });

  it('preserves source through snapshots, source mode, unmount and remount', () => {
    const source =
      '__粗体__、_斜体_、~~删除~~、<u>下划线</u>、<mark>高亮</mark>、`` `代码` ``、\\*字面\\*、**未闭合';
    const { editor, view, target, destroy } = setup(source);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const snapshot = editor.getSnapshot();
    editor.updateOptions({ mode: 'source' });
    editor.setMarkdown(source, { sourceInput: true });
    editor.updateOptions({ mode: 'semantic' });
    editor.unmount();
    editor.mount(target);
    editor.restoreSnapshot(snapshot);
    expect(editor.flushMarkdown()).toBe(source);
    expect(editor.getSnapshot().selection).toEqual({ anchor: 2, head: 2 });
    destroy();
  });

  it('projects partial rich selections using the complete source context', () => {
    const { editor, view, destroy } = setup('**重点**');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 5)));
    expect(editor.getClipboardPayload()).toMatchObject({ text: '重点' });
    expect(editor.getClipboardPayload()?.html).toContain('<strong>重点</strong>');
    editor.updateOptions({ copyMarkdownSyntaxEnabled: false });
    expect(editor.getClipboardPayload()?.text).toBe('重点');
    destroy();
  });

  it('maps legacy snapshot coordinates to real source while preserving selected text', () => {
    const { editor, destroy } = setup('');
    editor.restoreSnapshot({
      markdown: '**hello** tail',
      version: 3,
      selection: { anchor: 2, head: 5 },
    });
    expect(editor.getSnapshot().selection).toEqual({ anchor: 4, head: 7 });
    expect(editor.getClipboardPayload()?.text).toBe('ell');
    expect(editor.getClipboardPayload()?.html).toContain('<strong>ell</strong>');
    destroy();
  });

  it('materializes a restored legacy PM state and maps its selection at the entry point', () => {
    const editor = createEditorCore({ markdown: '**hello**' });
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(null, schema.text('hello', [schema.marks.strong.create()])),
    );
    (editor as unknown as { suspendedState: EditorState }).suspendedState = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2, 5),
    });
    const target = document.body.appendChild(document.createElement('div'));
    editor.mount(target);
    expect(editor.getSnapshot().selection).toEqual({ anchor: 4, head: 7 });
    expect(editor.getClipboardPayload()?.text).toBe('ell');
    expect(editor.getClipboardPayload()?.html).toContain('<strong>ell</strong>');
    editor.destroy();
    target.remove();
  });

  it('materializes HTML paste and projects all six formats for export when strict Markdown is disabled', () => {
    const { editor, view, destroy } = setup('');
    editor.updateOptions({ strictMarkdown: false });
    editor.pasteClipboardHtml(
      '<p><strong>粗</strong> <em>斜</em> <code>x*y</code> <s>删</s> <u>线</u> <mark>亮</mark></p>',
    );
    const marks = new Set<string>();
    view.state.doc.descendants((node) => node.marks.forEach((mark) => marks.add(mark.type.name)));
    expect([...marks]).toEqual(['inline_source']);
    const html = editor.getExportHtml!();
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<em>斜</em>');
    expect(html).toContain('x*y</code>');
    expect(html).toContain('<u>线</u>');
    expect(html).toContain('<mark>亮</mark>');
    expect(html).not.toContain('**');
    expect(projectInlineSource(view.state.doc).textContent).toBe('粗 斜 x*y 删 线 亮');
    destroy();
  });

  it('keeps source when copying part of a table and projects the plain-text option', () => {
    const { editor, view, destroy } = setup('| A |\n| --- |\n| **粗体** |');
    let from = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '**粗体**') from = pos;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 6)));
    expect(editor.getClipboardPayload()?.text).toBe('**粗体**');
    expect(editor.getClipboardPayload()?.html).toContain('<strong>粗体</strong>');
    editor.updateOptions({ copyMarkdownSyntaxEnabled: false });
    expect(editor.getClipboardPayload()?.text).toBe('粗体');
    destroy();
  });
});
