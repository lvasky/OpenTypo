import { isImageFile } from '../../lib/editor-core/imagePasteEvents';
import { serializeMarkdownLinkDestination } from '../../lib/editor-core/link';

export type ImageImportFile = Pick<File, 'name' | 'arrayBuffer'>;

export function getImageFiles(fileList: FileList | undefined | null) {
  return Array.from(fileList ?? []).filter(isImageFile);
}

export function createImageMarkdownSrc(fileName: string, imageName: string) {
  const baseName = fileName.replace(/\.(md|markdown)$/i, '') || 'document';
  const safeName = imageName
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-');
  return `./assets/${safeName || `${baseName}.png`}`;
}

export function createImageMarkdown(alt: string, src: string) {
  const safeAlt = alt.replace(/[\[\]\n\r]/g, ' ').trim() || 'image';
  return `![${safeAlt}](${serializeMarkdownLinkDestination(src)})`;
}
