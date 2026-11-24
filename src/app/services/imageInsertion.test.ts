import { describe, expect, it, vi } from 'vitest';
import { createEditorCore } from '../../lib/editor-core/createEditorCore';
import { DEFAULT_IMAGE_HANDLING_SETTINGS } from '../../lib/services/render';
import { createImageInsertionHandlers } from './imageInsertion';

const { importImage, resolveImage, invoke } = vi.hoisted(() => ({
  importImage: vi.fn(async () => ({ markdownSrc: './assets/photo.png' })),
  resolveImage: vi.fn(async (src: string) => ({ src, displaySrc: 'https://asset.localhost/photo.png', exists: true })),
  invoke: vi.fn(),
}));

vi.mock('../../lib/editor-core/renderers', () => ({
  getImageLoader: () => ({ import: importImage, resolve: resolveImage }),
}));

vi.mock('@tauri-apps/api/core', async (load) => ({
  ...await load<typeof import('@tauri-apps/api/core')>(),
  invoke,
}));

describe('image insertion Markdown policy', () => {
  it.each([true, false])('respects strict Markdown in source mode: %s', async (strictMarkdown) => {
    const editor = createEditorCore({ markdown: '', mode: 'source', strictMarkdown });
    const handlers = createImageInsertionHandlers({
      getEditor: () => editor,
      getStrictMarkdown: () => strictMarkdown,
      getMode: () => 'source',
      getFileName: () => 'note.md',
      getNativePath: () => 'C:\\docs\\note.md',
      getSourceEditor: () => undefined,
      getImageContext: () => ({
        settings: {
          ...DEFAULT_IMAGE_HANDLING_SETTINGS,
          defaultImageWidth: '240',
          defaultImageAlign: 'center',
        },
      }),
      saveMarkdownFile: () => true,
      setMarkdown: vi.fn(),
      setStatusMessage: vi.fn(),
      syncSourceTextareaHeight: vi.fn(),
    });
    try {
      await handlers.insertImageFiles([
        {
          name: 'photo.png',
          type: 'image/png',
          arrayBuffer: async () => new ArrayBuffer(0),
        } as File,
      ]);
      if (strictMarkdown) expect(editor.getMarkdown()).toBe('![photo.png](./assets/photo.png)');
      else expect(editor.getMarkdown()).toContain('<p align="center">');
    } finally {
      editor.destroy();
    }
  });
});

it.each([true, false])(
  'pastes an Excel table once, without its alternate bitmap (HTML: %s)',
  async (withTable) => {
    const host = document.body.appendChild(document.createElement('div'));
    const editor = createEditorCore({ target: host, markdown: '', strictMarkdown: true });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const handlers = createImageInsertionHandlers({
      getEditor: () => editor,
      getMode: () => 'semantic',
      getFileName: () => 'note.md',
      getNativePath: () => 'C:\\docs\\note.md',
      getSourceEditor: () => undefined,
      getImageContext: () => ({ settings: DEFAULT_IMAGE_HANDLING_SETTINGS }),
      saveMarkdownFile: () => true,
      setMarkdown: vi.fn(),
      setStatusMessage: vi.fn(),
      syncSourceTextareaHeight: vi.fn(),
    });
    host.addEventListener('paste', handlers.handleEditorPaste);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [
          { name: 'image.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(0) },
        ],
        getData: (format: string) =>
          withTable
            ? format === 'text/html'
              ? '<table><tr><th>PRI-&gt;Stage EMO信号</th></tr><tr><td>RLS-&gt;Stage 禁止运动</td></tr></table>'
              : 'PRI->Stage EMO信号\nRLS->Stage 禁止运动'
            : '',
      },
    });
    try {
      host.querySelector('.ProseMirror')!.dispatchEvent(event);
      await handlers.awaitPendingInsertions();
      const markdown = editor.getMarkdown();
      if (withTable) {
        expect(markdown).toContain('| PRI->Stage EMO信号 |');
        expect(markdown).toContain('| RLS->Stage 禁止运动 |');
        expect(markdown).not.toContain('![');
        expect(markdown).not.toContain('assets');
        expect(markdown.match(/PRI->Stage/g) ?? []).toHaveLength(1);
      } else {
        expect(markdown).toContain('![image.png](./assets/photo.png)');
      }
    } finally {
      host.removeEventListener('paste', handlers.handleEditorPaste);
      editor.destroy();
      host.remove();
    }
  },
);

it.each(['native-list', 'untyped-file'])(
  'pastes Explorer %s at the native caret and renders the imported image immediately',
  async (representation) => {
    const host = document.body.appendChild(document.createElement('div'));
    const editor = createEditorCore({
      target: host,
      markdown: 'First paragraph\n\nBefore after',
      getImageContext: () => ({ documentPath: 'C:/docs/note.md' }),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const handlers = createImageInsertionHandlers({
      getDesktopEnabled: () => true,
      getEditor: () => editor,
      getMode: () => 'semantic',
      getFileName: () => 'note.md',
      getNativePath: () => 'C:/docs/note.md',
      getSourceEditor: () => undefined,
      getImageContext: () => ({ documentPath: 'C:/docs/note.md' }),
      saveMarkdownFile: () => true,
      setMarkdown: vi.fn(),
      setStatusMessage: vi.fn(),
      syncSourceTextareaHeight: vi.fn(),
    });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'read_editor_clipboard_text') {
        return {
          html: '', text: '',
          image_paths: representation === 'native-list' ? ['C:\\Pictures\\photo.png'] : [],
        };
      }
      if (command === 'read_file_as_base64') return { data_url: 'data:image/png;base64,AQID' };
      throw new Error(command);
    });

    const file = { name: 'photo.png', type: '', arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer };
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        types: ['Files'],
        files: representation === 'untyped-file' ? [file] : [],
        getData: () => '',
      },
    });
    host.addEventListener('paste', handlers.handleEditorPaste);
    try {
      editor.focus();
      const paragraphs = host.querySelectorAll('.ProseMirror p');
      const text = document.createTreeWalker(paragraphs[1], NodeFilter.SHOW_TEXT);
      const caretNode = text.nextNode()!;
      expect(caretNode.textContent).toBe('Before after');
      document.getSelection()!.collapse(caretNode, 'Before '.length);
      host.querySelector('.ProseMirror')!.dispatchEvent(event);
      await handlers.awaitPendingInsertions();

      expect(editor.getMarkdown()).toBe('First paragraph\n\nBefore ![photo.png](./assets/photo.png)after');
      expect(importImage).toHaveBeenLastCalledWith(
        { fileName: 'photo.png', bytes: Uint8Array.of(1, 2, 3) },
        { documentPath: 'C:/docs/note.md' },
      );
      expect(resolveImage).toHaveBeenLastCalledWith('./assets/photo.png', { documentPath: 'C:/docs/note.md' });
      const image = host.querySelectorAll('.ProseMirror p')[1].querySelector('.image-node img');
      expect(image?.getAttribute('src')).toBe('https://asset.localhost/photo.png');
      if (representation === 'native-list') {
        expect(invoke).toHaveBeenCalledWith('read_file_as_base64', { input: { path: 'C:\\Pictures\\photo.png' } });
      }
    } finally {
      host.removeEventListener('paste', handlers.handleEditorPaste);
      editor.destroy();
      host.remove();
      invoke.mockReset();
    }
  },
);
