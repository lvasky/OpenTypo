import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { closeHistory } from 'prosemirror-history';
import type { MarkdownSyncAnchor } from './scrollSyncMapping';
import { isMarkdownTable } from './tableMarkdownSafety';

type TableSource = {
  original: Node;
  lines: string[];
  newline: string;
  originalRows?: Map<number, number>;
};

// Only live tables/undo states retain their original source and immutable rows.
// No DOM, document copies, global string cache or persistent listeners.
const sources = new WeakMap<Node, TableSource>();
export const tableSourceFormatKey = new PluginKey('tableSourceFormat');

export function rememberTableSources(
  doc: Node,
  markdown: string,
  anchors: MarkdownSyncAnchor[],
): void {
  const tables = anchors.filter((anchor) => anchor.kind === 'table' && anchor.edge === 'start');
  if (!tables.length) return;
  const lines = markdown.split(/\r?\n/);
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  for (const anchor of tables) {
    const table = doc.nodeAt(anchor.pos);
    if (!table) continue;
    let raw = lines.slice(anchor.fromLine - 1, anchor.toLine);
    // Strip container syntax, which the enclosing Markdown serializer restores.
    if (anchor.depth > 0) {
      raw = raw.map((line) => line.replace(/^(?:\s{0,3}> ?)+/, ''));
      const prefix = raw[0].match(/^\s*(?:(?:[-+*]|\d+[.)])\s+)+/)?.[0];
      if (prefix)
        raw = raw.map((line, index) =>
          index === 0
            ? line.slice(prefix.length)
            : line.replace(new RegExp(`^ {0,${prefix.length}}`), ''),
        );
      const indent = raw.reduce(
        (min, line) => (line.trim() ? Math.min(min, line.match(/^ */)![0].length) : min),
        Infinity,
      );
      if (indent > 0 && Number.isFinite(indent)) raw = raw.map((line) => line.slice(indent));
    }
    if (raw.length === table.childCount + 1 && /^\s*\|?\s*:?-{1,}/.test(raw[1] ?? '')) {
      sources.set(table, {
        original: table,
        lines: raw,
        newline,
      });
    }
  }
}

function inheritSources(tr: Transaction): void {
  tr.steps.forEach((step, index) => {
    const before = tr.docs[index];
    const after = tr.docs[index + 1] ?? tr.doc;
    const map = step.getMap();
    map.forEach((from, to) => {
      for (const pos of [from, to]) {
        const $pos = before.resolve(pos);
        const candidates: Array<{ node: Node; pos: number }> = [];
        for (let depth = $pos.depth; depth > 0; depth--) {
          if ($pos.node(depth).type.name === 'table')
            candidates.push({ node: $pos.node(depth), pos: $pos.before(depth) });
        }
        if ($pos.nodeAfter?.type.name === 'table') candidates.push({ node: $pos.nodeAfter, pos });
        for (const candidate of candidates) {
          const source = sources.get(candidate.node);
          const next = after.nodeAt(map.map(candidate.pos, -1));
          if (source && next?.type.name === 'table' && !sources.has(next)) {
            if (!source.originalRows && candidate.node.childCount === next.childCount) {
              sources.set(next, source);
              continue;
            }
            const nextStart = map.map(candidate.pos, -1) + 1;
            const movedRows = new Map<number, number>();
            candidate.node.forEach((_row, offset, index) => {
              const originalIndex = source.originalRows ? source.originalRows.get(index) : index;
              if (originalIndex === undefined) return;
              const mapped = map.mapResult(candidate.pos + 1 + offset, 1);
              if (!mapped.deleted) movedRows.set(mapped.pos - nextStart, originalIndex);
            });
            const originalRows = new Map<number, number>();
            next.forEach((_row, offset, index) => {
              const originalIndex = movedRows.get(offset);
              if (originalIndex !== undefined) originalRows.set(index, originalIndex);
            });
            sources.set(next, { ...source, originalRows });
          }
        }
      }
    });
  });
}

export function tableSourcePlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, state) {
      // Formatting is one undo event, independent of typing before and after it.
      return transactions.some((tr) => tr.getMeta(tableSourceFormatKey))
        ? closeHistory(state.tr).setMeta('addToHistory', false)
        : null;
    },
    state: {
      init: () => null,
      apply(tr) {
        inheritSources(tr);
        const formatted = tr.getMeta(tableSourceFormatKey) as
          | { pos: number; source: string }
          | undefined;
        const table = formatted && tr.doc.nodeAt(formatted.pos);
        if (table?.type.name === 'table')
          sources.set(table, {
            original: table,
            lines: formatted!.source.split(/\r?\n/),
            newline: formatted!.source.includes('\r\n') ? '\r\n' : '\n',
          });
        return null;
      },
    },
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Source columns in a monospace editor: CJK/fullwidth and emoji occupy two cells. */
export function sourceWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(segment)) continue;
    width +=
      /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Script=Han}|\p{Extended_Pictographic}/u.test(
        segment,
      )
        ? 2
        : 1;
  }
  return width;
}

function renderNewRow(
  row: Node,
  separator: string,
  bounds: Array<[number, number]>,
  renderCell: (cell: Node) => string,
): string {
  let line = separator;
  for (let column = bounds.length - 1; column >= 0; column--) {
    const [from, to] = bounds[column];
    const raw = separator.slice(from, to);
    const cell = row.child(column);
    const content = renderCell(cell);
    const padding = Math.max(0, raw.trim().length - sourceWidth(content));
    const before =
      cell.attrs.align === 'right'
        ? padding
        : cell.attrs.align === 'center'
          ? Math.floor(padding / 2)
          : 0;
    line =
      line.slice(0, from) +
      (raw.match(/^\s*/)?.[0] ?? '') +
      ' '.repeat(before) +
      content +
      ' '.repeat(padding - before) +
      (raw.match(/\s*$/)?.[0] ?? '') +
      line.slice(to);
  }
  // Outer pipes keep empty edge cells and leading alignment spaces unambiguous.
  if (bounds[0][0] === 0) line = '|' + line;
  if (bounds[bounds.length - 1][1] === separator.length) line += '|';
  return line;
}

/** Keep untouched rows verbatim, and replace only edited cell payloads. */
export function preserveTableSource(
  table: Node,
  renderCell: (cell: Node) => string,
): string | null {
  const source = sources.get(table);
  if (!source) return null;
  const { original, lines, newline } = source;
  if (table.eq(original)) return lines.join(newline);
  const { originalRows } = source;
  if (originalRows) {
    if (table.firstChild?.childCount !== original.firstChild?.childCount || !isMarkdownTable(table))
      return null;
  } else if (table.childCount !== original.childCount) {
    return null;
  }
  const result: string[] = [];
  const separators = cellBounds(lines[1]);
  let separator = lines[1];
  for (let column = table.child(0).childCount - 1; column >= 0; column--) {
    const align = table.child(0).child(column).attrs.align;
    if (align === original.child(0).maybeChild(column)?.attrs.align) continue;
    if (!separators[column]) return null;
    const [from, to] = separators[column];
    const raw = lines[1].slice(from, to);
    const dashes = raw.match(/-+/)?.[0];
    if (!dashes) return null;
    const marker =
      align === 'center'
        ? `:${dashes}:`
        : align === 'right'
          ? `${dashes}:`
          : align === 'left'
            ? `:${dashes}`
            : dashes;
    separator =
      separator.slice(0, from) +
      (raw.match(/^\s*/)?.[0] ?? '') +
      marker +
      (raw.match(/\s*$/)?.[0] ?? '') +
      separator.slice(to);
  }
  const newRowBounds = originalRows ? cellBounds(separator) : [];
  if (originalRows && newRowBounds.length !== table.child(0).childCount) return null;
  for (let row = 0; row < table.childCount; row++) {
    const next = table.child(row);
    const originalIndex = originalRows ? originalRows.get(row) : row;
    if (originalIndex === undefined) {
      result.push(renderNewRow(next, separator, newRowBounds, renderCell));
      continue;
    }
    const prev = original.child(originalIndex);
    const line = lines[originalIndex === 0 ? 0 : originalIndex + 1];
    if (next.eq(prev)) {
      result.push(line);
      continue;
    }
    if (next.childCount !== prev.childCount) return null;
    const bounds = cellBounds(line);
    if (bounds.length !== next.childCount) return null;
    let patched = line;
    for (let column = next.childCount - 1; column >= 0; column--) {
      const cell = next.child(column),
        old = prev.child(column);
      // Attribute/structure changes need fresh GFM separators or a new grid.
      if (
        (!originalRows && cell.type !== old.type) ||
        cell.attrs.colspan !== old.attrs.colspan ||
        cell.attrs.rowspan !== old.attrs.rowspan ||
        cell.attrs.colwidth !== old.attrs.colwidth ||
        cell.attrs.align !== table.child(0).child(column).attrs.align
      )
        return null;
      if (cell.content.eq(old.content)) continue;
      const [from, to] = bounds[column];
      const raw = line.slice(from, to);
      patched =
        patched.slice(0, from) +
        (raw.match(/^\s*/)?.[0] ?? '') +
        renderCell(cell) +
        (raw.trim() ? (raw.match(/\s*$/)?.[0] ?? '') : '') +
        patched.slice(to);
    }
    result.push(patched);
  }
  result.splice(1, 0, separator);
  return result.join(newline);
}

export function tableSourceCells(line: string): string[] {
  return cellBounds(line).map(([from, to]) => line.slice(from, to).trim());
}

function cellBounds(line: string): Array<[number, number]> {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) pipes.push(i);
  }
  const start = pipes[0] !== undefined && !line.slice(0, pipes[0]).trim() ? pipes.shift()! + 1 : 0;
  const last = pipes.at(-1);
  const end = last !== undefined && !line.slice(last + 1).trim() ? pipes.pop()! : line.length;
  const edges = [start - 1, ...pipes, end];
  return edges.slice(1).map((edge, i) => [edges[i] + 1, edge]);
}
