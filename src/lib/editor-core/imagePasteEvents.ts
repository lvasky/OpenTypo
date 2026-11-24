import type { EditorSelectionSnapshot } from './types';

export interface ImageInsertionTarget {
  selection: EditorSelectionSnapshot;
  contentRevision: number;
}

// Weak keys let the editor hand the paste and its selection to the import handler.
const delegatedImagePastes = new WeakMap<ClipboardEvent, ImageInsertionTarget>();

export function delegateImagePaste(event: ClipboardEvent, target: ImageInsertionTarget): void {
  delegatedImagePastes.set(event, target);
}

export function getDelegatedImagePaste(event: ClipboardEvent): ImageInsertionTarget | undefined {
  return delegatedImagePastes.get(event);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') ||
    ((!file.type || file.type === 'application/octet-stream') &&
      /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name));
}

export function getClipboardImageFiles(clipboard: DataTransfer | null | undefined): File[] {
  const files = Array.from(clipboard?.files ?? []).filter(isImageFile);
  if (files.length) return files;
  return Array.from(clipboard?.items ?? []).flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file && isImageFile(file) ? [file] : [];
  });
}

/** A WebView can omit the clipboard File objects for Explorer's native file list. */
export function mightHaveNativeImageFiles(clipboard: DataTransfer): boolean {
  const html = clipboard.getData('text/html');
  if (html) return /<img\b[^>]*\bsrc\s*=\s*["']?file:\/\//i.test(html);
  const text = (clipboard.getData('text/plain') || clipboard.getData('Text')).trim();
  const uris = clipboard.getData('text/uri-list').trim();
  if (/^file:\/\//i.test(text || uris)) return true;
  if (text && clipboard.types?.includes('Files')) return /^(?:[a-z]:[\\/]|\\\\)/i.test(text);
  return !text && !uris;
}
