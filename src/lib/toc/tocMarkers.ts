import { extractFrontMatterBlock } from '../markdown/frontMatter';

export const TOC_START_MARKER = '<!-- toc -->';
export const TOC_END_MARKER = '<!-- /toc -->';
export const TOC_PLACEHOLDER_MARKER = '[TOC]';

export function getTocStartInsertion(markdown: string): { from: number; insert: string; markerEnd: number } {
  const frontMatter = extractFrontMatterBlock(markdown);
  const from = frontMatter?.end ?? 0;
  const body = markdown.slice(from);
  const newline = frontMatter?.lineEnding ?? (markdown.includes('\r\n') ? '\r\n' : '\n');
  const before = frontMatter ? newline : '';
  const after = body ? newline.repeat(/^\r?\n/.test(body) ? 1 : 2) : '';
  return {
    from,
    insert: `${before}${TOC_PLACEHOLDER_MARKER}${after}`,
    markerEnd: from + before.length + TOC_PLACEHOLDER_MARKER.length,
  };
}
