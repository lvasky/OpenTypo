import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { analyzeInlineSource, isInlineSourceText } from '../editor-core/InlineSourceCodec';
import { createMarkdownTokenizer, isRenderedImageHtml } from '../editor-core/markdownTokenizer';
import { classifyHtmlBlock } from '../editor-core/html/htmlClassifier';
import { INLINE_TAG_TO_MARK } from '../editor-core/html/htmlPolicy';
import { normalizeLinkHref } from '../editor-core/link';
import { splitFrontMatterBlock } from '../markdown/frontMatter';
import { locateTableCells, recordInlinePositions, tokenSpans } from './sourceTokenPositions';
import type { DocumentStats } from './outlineService';

interface BodyRun {
  text: string;
  starts: number[];
  ends: number[];
}
interface Boundaries {
  starts: number[];
  ends: number[];
}
export interface WritingStatsIndex {
  words: Boundaries;
  characters: Boundaries;
  newlines: number[];
  normalizedCRLF: number[];
  length: number;
  headings: number;
}

const tokenizer = createMarkdownTokenizer({ literalHtmlCode: true });
recordInlinePositions(tokenizer);
const Segmenter = (
  Intl as typeof Intl & {
    Segmenter: new (
      locale: string,
      options: { granularity: string },
    ) => {
      segment(text: string): Iterable<{ segment: string; index: number }>;
    };
  }
).Segmenter;
const graphemes = Segmenter ? new Segmenter('en', { granularity: 'grapheme' }) : null;
const han = /\p{Script=Han}/u;
const wordPattern =
  /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’_-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*|(?<=\p{N})\.(?=\p{N})[\p{N}]+)*/gu;
const excludedNodes = new Set([
  'code_block',
  'math_block',
  'math_inline',
  'mermaid_block',
  'image',
  'comment_inline',
  'comment_block',
  'toc_block',
  'footnote_ref',
]);

function emptyRun(): BodyRun {
  return { text: '', starts: [], ends: [] };
}

function append(run: BodyRun, text: string, positions: number[], ends?: number[]): void {
  run.text += text;
  for (let i = 0; i < positions.length; i++) {
    run.starts.push(positions[i]);
    run.ends.push(ends?.[i] ?? positions[i] + 1);
  }
}

function removeTaskPrefix(run: BodyRun, inList: boolean, startsWithCode: boolean): void {
  if (!inList || startsWithCode) return;
  const length = /^\[[ xX]\]\s?/.exec(run.text)?.[0].length ?? 0;
  if (!length) return;
  run.text = run.text.slice(length);
  run.starts.splice(0, length);
  run.ends.splice(0, length);
}

function buildIndex(
  runs: BodyRun[],
  length: number,
  newlines: number[],
  headings: number,
  normalizedCRLF: number[] = [],
): WritingStatsIndex {
  if (!graphemes) throw new Error('Unicode character segmentation unavailable');
  const words: Boundaries = { starts: [], ends: [] };
  const characters: Boundaries = { starts: [], ends: [] };
  const add = (bounds: Boundaries, run: BodyRun, from: number, to: number) => {
    if (from >= to || run.starts[from] === undefined) return;
    bounds.starts.push(run.starts[from]);
    bounds.ends.push(run.ends[to - 1]);
  };
  for (const run of runs) {
    // Han characters are separate words. Replace them with separators before Latin matching.
    const latin = run.text.replace(/\p{Script=Han}/gu, (value) => ' '.repeat(value.length));
    const found: Array<[number, number]> = [];
    for (const { segment, index } of graphemes.segment(run.text)) {
      if (/^[\s\p{Cf}]+$/u.test(segment)) continue;
      add(characters, run, index, index + segment.length);
      if (han.test(segment)) found.push([index, index + segment.length]);
    }
    for (const match of latin.matchAll(wordPattern))
      found.push([match.index, match.index + match[0].length]);
    found.sort((a, b) => a[0] - b[0]);
    for (const [from, to] of found) add(words, run, from, to);
  }
  return { words, characters, length, newlines, headings, normalizedCRLF };
}

function upperBound(values: number[], value: number): number {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function overlaps(bounds: Boundaries, from: number, to: number): [number, number] {
  return [upperBound(bounds.ends, from), upperBound(bounds.starts, to - 1)];
}

/** CodeMirror 的 LF 坐标映射回原始 Markdown；范围请求只做二分查找。 */
export function sourceRangeToRaw(
  index: WritingStatsIndex,
  from: number,
  to: number,
): [number, number] {
  return [
    from + upperBound(index.normalizedCRLF, from - 1),
    to + upperBound(index.normalizedCRLF, to - 1),
  ];
}

export function queryWritingStats(
  index: WritingStatsIndex,
  from = 0,
  to = index.length,
): DocumentStats {
  [from, to] = [
    Math.max(0, Math.min(index.length, from, to)),
    Math.max(0, Math.min(index.length, Math.max(from, to))),
  ];
  const [first, last] = overlaps(index.characters, from, to);
  const visibleChars = Math.max(0, last - first);
  const [wordFirst, wordLast] = visibleChars
    ? overlaps(
        index.words,
        Math.max(from, index.characters.starts[first]),
        Math.min(to, index.characters.ends[last - 1]),
      )
    : [0, 0];
  const words = Math.max(0, wordLast - wordFirst);
  return {
    chars: to - from,
    words,
    visibleChars,
    lines: upperBound(index.newlines, to - 1) - upperBound(index.newlines, from - 1) + 1,
    headings: from === 0 && to === index.length ? index.headings : 0,
    readingMinutes: Math.max(1, Math.ceil(words / 280)),
  };
}

function containerPrefixLength(line: string, lists: number, quotes: number): number {
  let offset = 0;
  while (lists || quotes) {
    const remaining = line.slice(offset);
    const quote = quotes ? /^[ \t]*>[ \t]?/.exec(remaining)?.[0] : undefined;
    if (quote) {
      offset += quote.length;
      quotes--;
      continue;
    }
    const list = lists ? /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(remaining)?.[0] : undefined;
    if (!list) break;
    offset += list.length;
    lists--;
  }
  return offset;
}

/** Limit every lookup to the token's own source lines. */
function locateInline(
  content: string,
  source: string,
  from: number,
  to: number,
  lists: number,
  quotes: number,
  heading: boolean,
): number[] | null {
  const rawLines = source.slice(from, to).split(/(\r\n?|\n)/);
  const parts = content.split('\n');
  const result: number[] = [];
  let lineStart = from;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = rawLines[i * 2];
    if (raw === undefined) {
      // HTML blocks can include a synthesized final LF at EOF.
      if (i === parts.length - 1 && !part && lineStart === to) break;
      return null;
    }
    let offset = containerPrefixLength(raw, i === 0 ? lists : 0, quotes);
    if (i === 0 && heading) offset += /^[ \t]*#{1,6}[ \t]+/.exec(raw.slice(offset))?.[0].length ?? 0;
    const line = raw.replace(/\0/g, '\uFFFD');
    // markdown-it can leave synthetic leading spaces when it partially expands an indenting tab.
    const text = part.trimStart();
    const found = line.indexOf(text, offset);
    if (found < 0) return null;
    const leading = part.length - text.length;
    for (let j = 0; j < leading; j++) result.push(lineStart + Math.max(offset, found - leading + j));
    for (let j = 0; j < text.length; j++) result.push(lineStart + found + j);
    if (i < parts.length - 1) result.push(lineStart + raw.length);
    lineStart += raw.length + (rawLines[i * 2 + 1]?.length ?? 0);
  }
  return result;
}

/** markdown-it 将 CRLF／CR 规范化为 LF，块内容必须按原始行范围映射回源码。 */
function locateBlock(
  content: string,
  source: string,
  from: number,
  to: number,
  lists: number,
  quotes: number,
): number[] | null {
  const positions: number[] = [];
  let normalized = '';
  for (let i = from; i < to; i++) {
    positions.push(i);
    if (source[i] === '\r') {
      normalized += '\n';
      if (source[i + 1] === '\n') i++;
    } else normalized += source[i] === '\0' ? '\uFFFD' : source[i];
  }
  const offset = normalized.indexOf(content);
  if (offset < 0) return locateInline(content, source, from, to, lists, quotes, false);
  return positions.slice(offset, offset + content.length);
}

export function buildSourceWritingStats(markdown: string): WritingStatsIndex {
  const { frontMatter, body } = splitFrontMatterBlock(markdown);
  const bodyStart = frontMatter ? markdown.indexOf(body, frontMatter.length) : 0;
  const newlines: number[] = [];
  const normalizedCRLF: number[] = [];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === '\n' || markdown[i] === '\r') {
      if (markdown[i] === '\r' && markdown[i + 1] === '\n') {
        normalizedCRLF.push(i - normalizedCRLF.length);
        i++;
      }
      newlines.push(i);
    }
  }
  const bodyLines = [bodyStart];
  for (let i = bodyStart; i < markdown.length; i++) {
    if (markdown[i] === '\n' || markdown[i] === '\r') {
      if (markdown[i] === '\r' && markdown[i + 1] === '\n') i++;
      bodyLines.push(i + 1);
    }
  }
  const runs: BodyRun[] = [];
  let cursor = bodyStart;
  let headings = 0;
  let listDepth = 0,
    quoteDepth = 0;
  let inHeading = false;
  const htmlMarks: string[] = [];
  let tableCells: ReturnType<typeof locateTableCells> | null = null;
  let tableColumn = 0;
  for (const token of tokenizer.parse(body, {})) {
    if (token.type === 'list_item_open') listDepth++;
    if (token.type === 'list_item_close') listDepth--;
    if (token.type === 'blockquote_open' || token.type === 'callout_open') quoteDepth++;
    if (token.type === 'blockquote_close' || token.type === 'callout_close') quoteDepth--;
    if (token.type === 'heading_open') {
      headings++;
      inHeading = true;
    }
    if (token.type === 'heading_close') inHeading = false;
    if (token.map) cursor = Math.max(cursor, bodyLines[token.map[0]] ?? cursor);
    if (token.type === 'tr_open' && token.map) {
      const [line] = token.map;
      const from = bodyLines[line];
      const raw = markdown.slice(from, bodyLines[line + 1] ?? markdown.length);
      const prefix = containerPrefixLength(raw, listDepth, quoteDepth);
      tableCells = locateTableCells(raw.slice(prefix), from + prefix);
      tableColumn = 0;
    }
    if (token.type === 'tr_close') tableCells = null;
    if (token.type === 'html_block' && token.map) {
      const classification = classifyHtmlBlock(token.content);
      if (!classification.editable &&
          (/^\s*<!--/.test(token.content) || isRenderedImageHtml(token.content))) continue;
      const run = emptyRun();
      const positions = locateBlock(
        token.content,
        markdown,
        bodyLines[token.map[0]],
        bodyLines[token.map[1]] ?? markdown.length,
        listDepth,
        quoteDepth,
      );
      if (!positions?.length) continue;
      if (!classification.editable) {
        // Unsupported HTML is displayed as literal text by the semantic parser.
        append(run, token.content, positions);
        runs.push(run);
        cursor = positions.at(-1)! + 1;
        continue;
      }
      const re = /<!--[^]*?-->|<[^>]*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[^<&]+|[<&]/gi;
      let codeDepth = 0,
        startsWithCode = false;
      for (const match of token.content.matchAll(re)) {
        if (match[0].startsWith('<')) {
          if (/^<code\b/i.test(match[0])) codeDepth++;
          if (/^<\/code\b/i.test(match[0])) codeDepth = Math.max(0, codeDepth - 1);
          continue;
        }
        const decoded = tokenizer.utils.unescapeAll(match[0]);
        if (!run.text) startsWithCode = codeDepth > 0;
        append(
          run,
          decoded,
          Array.from(
            { length: decoded.length },
            (_, i) => positions[match.index + (decoded === match[0] ? i : 0)],
          ),
          Array.from(
            { length: decoded.length },
            (_, i) => positions[match.index + (decoded === match[0] ? i : match[0].length - 1)] + 1,
          ),
        );
      }
      removeTaskPrefix(run, listDepth > 0, startsWithCode);
      runs.push(run);
      cursor = positions.at(-1)! + 1;
    }
    if (token.type !== 'inline') continue;
    const tableCell = tableCells?.[tableColumn++];
    if (!token.content) continue;
    const original: string = token.meta?.statsContent ?? token.content;
    const inlineStart =
      token.meta?.statsContentColumn !== undefined && token.map
        ? bodyLines[token.map[0]] + token.meta.statsContentColumn
        : cursor;
    const positions = tableCells
      ? (tableCell?.text === original ? tableCell.positions : null)
      : locateInline(
          original,
          markdown,
          inlineStart,
          token.map ? bodyLines[token.map[1]] ?? markdown.length : markdown.length,
          listDepth,
          quoteDepth,
          inHeading,
        );
    // An unmappable token should not prevent opening or indexing the rest of the document.
    if (!positions?.length) continue;
    cursor = positions.at(-1)! + 1;
    const run = emptyRun();
    let startsWithCode = false;
    for (const child of token.children ?? []) {
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        append(run, '\n', [positions[0]]);
        continue;
      }
      if (child.type === 'html_inline') {
        const tag = /^<\/?([a-z]+)/i.exec(child.content)?.[1]?.toLowerCase();
        if (/^<!--/.test(child.content)) continue;
        if (/\/>$/.test(child.content)) {
          if (tag === 'br') {
            const from = tokenSpans(child)[0]?.from ?? 0;
            append(run, '\n', [positions[from]]);
            continue;
          }
        } else if (child.content.startsWith('</')) {
          const index = tag ? htmlMarks.lastIndexOf(tag) : -1;
          if (index >= 0) {
            htmlMarks.length = index;
            continue;
          }
        } else if (tag && (INLINE_TAG_TO_MARK[tag] || tag === 'mark')) {
          const href = /href="([^"]*)"/i.exec(child.content)?.[1];
          if (tag !== 'a' || normalizeLinkHref(href ?? '') !== null) {
            htmlMarks.push(tag);
            continue;
          }
        }
      }
      if (!['text', 'text_special', 'code_inline', 'inline_source_code', 'html_inline'].includes(child.type)) continue;
      if (!child.content) continue;
      for (const span of tokenSpans(child)) {
        const text = span.text;
        if (!text) continue;
        if (!run.text) startsWithCode = child.type === 'code_inline' || child.type === 'inline_source_code' || htmlMarks.includes('code');
        const rawLength = span.to - span.from;
        const sameLength = rawLength === span.text.length;
        const starts = Array.from(
          { length: text.length },
          (_, i) => positions[span.from + (sameLength ? i : 0)],
        );
        const ends = Array.from(
          { length: text.length },
          (_, i) => (positions[span.from + (sameLength ? i : rawLength - 1)] ?? starts[i]) + 1,
        );
        append(run, text, starts, ends);
      }
    }
    removeTaskPrefix(run, listDepth > 0, startsWithCode);
    if (run.text) runs.push(run);
  }
  return buildIndex(runs, markdown.length, newlines, headings, normalizedCRLF);
}

export function buildSemanticWritingStats(doc: ProseMirrorNode): WritingStatsIndex {
  const runs: BodyRun[] = [];
  const listContent = new WeakSet<ProseMirrorNode>();
  let headings = 0;
  doc.descendants((node, pos, parent) => {
    if (node.type.name === 'list_item' || (parent && listContent.has(parent)))
      listContent.add(node);
    if (excludedNodes.has(node.type.name)) return false;
    if (!node.isTextblock) return true;
    if (node.type.name === 'heading') headings++;
    const run = emptyRun();
    let startsWithCode = false;
    let hasSource = false;
    node.forEach((child) => { hasSource ||= isInlineSourceText(child); });
    if (hasSource && node.type.name !== 'html_block') {
      const analysis = analyzeInlineSource(node);
      const omitted: Array<{ from: number; to: number }> = [];
      node.forEach((child, offset) => {
        if (!child.isText && child.type.name !== 'hard_break') omitted.push({ from: offset, to: offset + child.nodeSize });
      });
      for (let i = 0; i < analysis.visibleText.length; i++) {
        const offset = analysis.visiblePositions[i];
        if (omitted.some((range) => offset >= range.from && offset < range.to)) continue;
        if (!run.text) startsWithCode = analysis.spans.some((span) => span.type === 'code' && offset >= span.from && offset < span.to);
        append(run, analysis.visibleText[i], [pos + 1 + offset]);
      }
      removeTaskPrefix(run, listContent.has(node), startsWithCode);
      runs.push(run);
      return false;
    }
    node.forEach((child, offset) => {
      if (child.isText) {
        const text = child.text ?? '';
        if (!run.text) startsWithCode = child.marks.some((mark) => mark.type.name === 'code');
        append(
          run,
          text,
          Array.from({ length: text.length }, (_, i) => pos + 1 + offset + i),
        );
      } else if (child.type.name === 'hard_break') append(run, '\n', [pos + 1 + offset]);
    });
    removeTaskPrefix(run, listContent.has(node), startsWithCode);
    runs.push(run);
    return false;
  });
  return buildIndex(runs, doc.content.size, [], headings);
}

export function calculateWritingStats(markdown: string): DocumentStats {
  return queryWritingStats(buildSourceWritingStats(markdown));
}
