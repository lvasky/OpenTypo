import type { Node } from 'prosemirror-model';
import { removeEmptyTrailingParagraph } from './plugins/trailingParagraph';
import { parseMarkdownWithSyncAnchors, serializeMarkdown } from './markdown';
import { preserveTableSource } from './tableSource';

type BlockRange = { from: number; to: number; pos: number };
type Patch = { from: number; to: number; text: string };
type SourceRanges = { blocks: BlockRange[] | null; byPosition: Map<number, BlockRange> };
type Render = (nodes: Node[]) => string;

const rangesByBaseline = new WeakMap<Node, SourceRanges>();
const containers = new Set(['bullet_list', 'ordered_list', 'list_item', 'blockquote']);

function getSourceRanges(baseline: Node, source: string): SourceRanges {
  const cached = rangesByBaseline.get(baseline);
  if (cached) return cached;
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const { anchors } = parseMarkdownWithSyncAnchors(source);
  const blocks: BlockRange[] = [];
  const byPosition = new Map<number, BlockRange>();
  for (const anchor of anchors) {
    if (anchor.edge !== 'start') continue;
    const from = starts[anchor.fromLine - 1];
    if (from === undefined) continue;
    let to = starts[anchor.toLine] ?? source.length;
    if (source[to - 1] === '\n') to--;
    if (source[to - 1] === '\r') to--;
    const range = { from, to, pos: anchor.pos };
    byPosition.set(anchor.pos, range);
    if (anchor.depth === 0) blocks.push(range);
  }
  const ranges = {
    blocks: blocks.length === removeEmptyTrailingParagraph(baseline).childCount ? blocks : null,
    byPosition,
  };
  rangesByBaseline.set(baseline, ranges);
  return ranges;
}

function sourceLines(text: string): Array<{ text: string; ending: string }> {
  const lines = text.split(/(\r?\n)/);
  const result: Array<{ text: string; ending: string }> = [];
  for (let i = 0; i < lines.length; i += 2)
    result.push({ text: lines[i], ending: lines[i + 1] ?? '' });
  return result;
}

/** Reuse a fenced block's delimiter, info string, indent, and untouched body lines. */
function patchFence(before: Node, after: Node, raw: string, newline: string): string | null {
  if (!before.sameMarkup(after)) return null;
  const lines = sourceLines(raw);
  const quote = /^(?: {0,3}> ?)+/.exec(lines[0].text)?.[0] ?? '';
  const listIndent = /^ {4,}(?=[`~]{3})/.exec(lines[0].text.slice(quote.length))?.[0] ?? '';
  const prefix = quote + listIndent;
  if (lines.some((line) => !line.text.startsWith(prefix))) return null;
  const openingText = lines[0].text.slice(prefix.length);
  const opening = /^( {0,3})(`{3,}|~{3,}).*$/.exec(openingText);
  if (!opening) return null;
  const [, indent, fence] = opening;
  const closing = lines[lines.length - 1].text.slice(prefix.length);
  const marker = fence[0];
  const closingFence = new RegExp(`^ {0,3}(${marker}{${fence.length},})[ \t]*$`).exec(closing);
  const hasCloser = lines.length > 1 && closingFence !== null;
  const body = hasCloser ? lines.slice(1, -1) : lines.slice(1);
  const afterCode = after.textContent;
  const unindent = new RegExp(`^ {0,${indent.length}}`);
  const previous = body.map((line) => line.text.slice(prefix.length).replace(unindent, ''));
  if (previous.join('\n') !== before.textContent) return null;
  const next = afterCode ? afterCode.split('\n') : [];
  let first = 0;
  while (first < previous.length && first < next.length && previous[first] === next[first]) first++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > first && newEnd > first && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  let fenceLength = fence.length;
  const delimiter = new RegExp(`^ {0,3}(${marker}{3,})[ \t]*$`);
  for (const line of next) {
    const match = delimiter.exec(line);
    if (match) fenceLength = Math.max(fenceLength, match[1].length + 1);
  }

  const opener = prefix + indent + marker.repeat(fenceLength) + openingText.slice(indent.length + fence.length);
  const closer = hasCloser
    ? prefix + closing.replace(closingFence[1], marker.repeat(Math.max(fenceLength, closingFence[1].length)))
    : '';
  const edited = next.slice(first, newEnd).map((line, index) => ({
    text: prefix + indent + line,
    ending: body[first + index]?.ending || newline,
  }));
  const nextBody = [...body.slice(0, first), ...edited, ...body.slice(oldEnd)];
  const content = nextBody.map((line, index) => line.text +
    (hasCloser || index < nextBody.length - 1 ? line.ending || newline : '')).join('');
  return opener + (hasCloser || content ? lines[0].ending || newline : '') + content + closer;
}

function containerPrefix(text: string): string {
  return /^[ \t]*(?:(?:>[ \t]*|(?:[-+*]|\d+[.)])[ \t]+))*/.exec(text)![0];
}

function patchLines(raw: string, before: string, after: string, paragraph = false): string | null {
  const lines = sourceLines(raw);
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);

  if (oldLines.length !== lines.length) return null;
  const prefixes = lines.map(({ text }, index) => {
    const oldText = oldLines[index];
    const position = oldText ? text.lastIndexOf(oldText) : -1;
    if (position < 0 || text.slice(position + oldText.length).trim()) return null;
    const prefix = text.slice(0, position);
    return containerPrefix(prefix) === prefix ? prefix : null;
  });
  if (newLines.length !== lines.length) {
    const prefix = prefixes[0];
    // Quotes and indented containers can prefix inserted lines the same way.
    if (paragraph || prefix === null || prefixes.some((value) => value !== prefix)) return null;
    const endings = new Map<string, string>();
    for (let i = 0; i < oldLines.length; i++)
      if (lines[i].ending) endings.set(oldLines[i], lines[i].ending);
    return newLines.map((line, index) =>
      prefix + line + (index === newLines.length - 1 ? '' : endings.get(line) || lines[0].ending || '\n'),
    ).join('');
  }

  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { text, ending } = lines[i];
    if (oldLines[i] === newLines[i]) {
      result.push(text + ending);
      continue;
    }
    const prefix = prefixes[i];
    if (prefix !== null) {
      result.push(prefix + newLines[i] + text.slice(prefix.length + oldLines[i].length) + ending);
    } else if (paragraph && lines.length === 1 && newLines[i]) {
      // A paragraph may use a different spelling from its serialized form.
      // Its single-line list/quote prefix and trailing padding still belong to the source.
      result.push(containerPrefix(text) + newLines[i] + text.slice(text.trimEnd().length) + ending);
    } else {
      return null;
    }
  }
  return result.join('');
}

function patchBlock(
  before: Node,
  after: Node,
  pos: number,
  source: string,
  ranges: Map<number, BlockRange>,
  render: Render,
  newline: string,
  patches: Patch[],
): boolean {
  if (before.eq(after)) return true;
  if (before.type !== after.type) return false;
  const range = ranges.get(pos);

  if (containers.has(before.type.name)) {
    if (!before.sameMarkup(after) || before.childCount !== after.childCount) return false;
    let childPos = pos + 1;
    for (let index = 0; index < before.childCount; index++) {
      const child = before.child(index);
      if (!patchBlock(child, after.child(index), childPos, source, ranges, render, newline, patches))
        return false;
      childPos += child.nodeSize;
    }
    return true;
  }
  if (!range) return false;

  const raw = source.slice(range.from, range.to);
  let text: string | null = null;
  if (before.type.name === 'code_block') {
    text = patchFence(before, after, raw, newline);
  } else if (before.type.name === 'paragraph') {
    text = patchLines(raw, render([before]), render([after]), true);
  } else if (before.type.name === 'table') {
    if (preserveTableSource(before, () => '') !== null)
      text = patchLines(raw, render([before]), render([after]));
  }
  if (text === null) return false;
  patches.push({ ...range, text });
  return true;
}

type ChangedInterval = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };

/** Find unchanged blocks by identity in the middle, in addition to equal ends. */
function changedIntervals(before: Node, after: Node): ChangedInterval[] {
  let first = 0;
  while (first < Math.min(before.childCount, after.childCount) && before.child(first).eq(after.child(first)))
    first++;
  let oldEnd = before.childCount;
  let newEnd = after.childCount;
  while (oldEnd > first && newEnd > first && before.child(oldEnd - 1).eq(after.child(newEnd - 1))) {
    oldEnd--;
    newEnd--;
  }
  if (oldEnd === first && newEnd === first) return [];

  const positions = new Map<Node, number>();
  for (let i = first; i < oldEnd; i++) positions.set(before.child(i), i);
  const intervals: ChangedInterval[] = [];
  let oldStart = first;
  let newStart = first;
  for (let i = first; i < newEnd; i++) {
    const node = after.child(i);
    const previous = oldEnd === newEnd && i >= oldStart && before.child(i).eq(node)
      ? i
      : positions.get(node);
    if (previous === undefined || previous < oldStart) continue;
    if (previous !== oldStart || i !== newStart)
      intervals.push({ oldStart, oldEnd: previous, newStart, newEnd: i });
    oldStart = previous + 1;
    newStart = i + 1;
  }
  if (oldStart !== oldEnd || newStart !== newEnd)
    intervals.push({ oldStart, oldEnd, newStart, newEnd });
  return intervals;
}

/** Apply disjoint source patches and keep the gaps between them byte for byte. */
export function serializeSourceChange(
  doc: Node,
  baseline: Node,
  source: string,
  strictMarkdown?: boolean,
): string | null {
  const { blocks, byPosition } = getSourceRanges(baseline, source);
  if (!blocks) return null;
  baseline = removeEmptyTrailingParagraph(baseline);
  const intervals = changedIntervals(baseline, doc);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const render: Render = (nodes) => serializeMarkdown(doc.type.create(null, nodes), { strictMarkdown });
  const patches: Patch[] = [];
  for (const { oldStart, oldEnd, newStart, newEnd } of intervals) {
    if (oldEnd - oldStart === newEnd - newStart) {
      for (let oldIndex = oldStart; oldIndex < oldEnd; oldIndex++) {
        const range = blocks[oldIndex];
        const previous = baseline.child(oldIndex);
        const next = doc.child(newStart + oldIndex - oldStart);
        const local: Patch[] = [];
        if (patchBlock(previous, next, range.pos, source, byPosition, render, newline, local))
          patches.push(...local);
        else
          patches.push({ ...range, text: render([next]).replace(/\r?\n/g, newline) });
      }
      continue;
    }

    const nodes: Node[] = [];
    for (let i = newStart; i < newEnd; i++) nodes.push(doc.child(i));
    let text = nodes.length ? render(nodes).replace(/\r?\n/g, newline) : '';
    let from = blocks[oldStart]?.from ?? blocks[oldStart - 1]?.to ?? source.length;
    let to = oldEnd > oldStart ? blocks[oldEnd - 1].to : from;
    if (!nodes.length) {
      const gap = oldStart > 0 ? source.slice(blocks[oldStart - 1].to, from) : '';
      if (oldStart > 0) from = blocks[oldStart - 1].to;
      to = blocks[oldEnd]?.from ?? to;
      text = oldStart > 0 && oldEnd < blocks.length ? gap : '';
    } else if (oldEnd === oldStart) {
      if (oldStart === blocks.length && oldStart > 0) text = newline + newline + text;
      if (oldStart < blocks.length) text += newline + newline;
    }
    patches.push({ from, to, text });
  }

  const oldPrefix = String(baseline.attrs.frontMatterPrefix ?? '');
  const newPrefix = String(doc.attrs.frontMatterPrefix ?? '');
  if (oldPrefix !== newPrefix) patches.push({ from: 0, to: oldPrefix.length, text: newPrefix });
  if (!patches.length) return source;

  const parts: string[] = [];
  let end = 0;
  for (const { from, to, text } of patches.sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (from < end) return null;
    parts.push(source.slice(end, from), text);
    end = to;
  }
  parts.push(source.slice(end));
  return parts.join('');
}
