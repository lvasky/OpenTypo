import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { closeHistory } from 'prosemirror-history';
import { AddMarkStep, RemoveMarkStep, type StepMap } from 'prosemirror-transform';
import type { MarkdownSyncAnchor } from './scrollSyncMapping';
import { isMarkdownTable } from './tableMarkdownSafety';

type TableSource = {
  original: Node;
  lines: string[];
  newline: string;
  originalRows?: Array<number | undefined>;
  originalColumns?: Array<number | undefined>;
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

function sourceIndex(indices: Array<number | undefined> | undefined, index: number) {
  return indices ? indices[index] : index;
}

/** Whole-table commands supply the row/column order of their replacement. */
export function remapTableSource(
  before: Node,
  after: Node,
  rowFrom: (index: number) => number,
  columnFrom: (index: number) => number,
): void {
  const source = sources.get(before);
  if (!source) return;
  sources.set(after, {
    ...source,
    originalRows: Array.from({ length: after.childCount }, (_, index) => {
      const previous = rowFrom(index);
      return previous < before.childCount ? sourceIndex(source.originalRows, previous) : undefined;
    }),
    originalColumns: Array.from({ length: after.firstChild!.childCount }, (_, index) => {
      const previous = columnFrom(index);
      return previous < before.firstChild!.childCount
        ? sourceIndex(source.originalColumns, previous)
        : undefined;
    }),
  });
}

function mapChildren(
  before: Node,
  after: Node,
  oldStart: number,
  newStart: number,
  map: StepMap,
  indices: Array<number | undefined> | undefined,
  original: Node,
): Array<number | undefined> {
  const mapped = new Map<number, number>();
  before.forEach((_child, offset, index) => {
    const original = sourceIndex(indices, index);
    const pos = map.mapResult(oldStart + offset, 1);
    if (original !== undefined && !pos.deleted) mapped.set(pos.pos, original);
  });
  const result: Array<number | undefined> = [];
  after.forEach((_child, offset) => result.push(mapped.get(newStart + offset)));
  // History may reinsert an original row/cell that has no position in the previous step.
  if (result.includes(undefined)) {
    const available = new Map<Node, number>();
    const used = new Set(result);
    original.forEach((child, _offset, index) => {
      if (!used.has(index)) available.set(child, index);
    });
    after.forEach((child, _offset, index) => {
      if (result[index] !== undefined) return;
      result[index] = available.get(child);
      available.delete(child);
    });
  }
  return result;
}

function inheritSources(tr: Transaction): void {
  tr.steps.forEach((step, index) => {
    const before = tr.docs[index];
    const after = tr.docs[index + 1] ?? tr.doc;
    const map = step.getMap();
    const inheritAt = (pos: number) => {
      const $pos = before.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth--) {
        const table = $pos.node(depth);
        const source = sources.get(table);
        if (!source || table.type.name !== 'table') continue;
        const oldPos = $pos.before(depth);
        const newPos = map.map(oldPos, -1);
        const next = after.nodeAt(newPos);
        if (next?.type !== table.type || sources.has(next)) continue;
        // Do not mistake a different table at the boundary of a deletion for this one.
        if (map.mapResult(oldPos, 1).deleted) continue;
        const originalRows = table.childCount === next.childCount
          ? source.originalRows
          : mapChildren(table, next, oldPos + 1, newPos + 1, map, source.originalRows, source.original);
        const oldHeader = table.firstChild;
        const newHeader = next.firstChild;
        const originalColumns = oldHeader && newHeader && oldHeader.childCount !== newHeader.childCount
          ? mapChildren(oldHeader, newHeader, oldPos + 2, newPos + 2, map, source.originalColumns, source.original.firstChild!)
          : source.originalColumns;
        sources.set(next, originalRows === source.originalRows && originalColumns === source.originalColumns
          ? source
          : { ...source, originalRows, originalColumns });
      }
    };
    map.forEach((from, to) => {
      inheritAt(from);
      if (to !== from) inheritAt(to);
    });
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      inheritAt(step.from);
      if (step.to !== step.from) inheritAt(step.to);
    }
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

function paddedCell(cell: Node, template: string, renderCell: (cell: Node) => string): string {
  const content = renderCell(cell);
  const padding = Math.max(0, template.trim().length - sourceWidth(content));
  const before =
    cell.attrs.align === 'right'
      ? padding
      : cell.attrs.align === 'center'
        ? Math.floor(padding / 2)
        : 0;
  return edgeSpace(template, true) + ' '.repeat(before) + content
    + ' '.repeat(padding - before) + edgeSpace(template, false);
}

function edgeSpace(text: string, leading: boolean): string {
  return text.match(leading ? /^\s*/ : /\s*$/)?.[0] ?? '';
}

function joinCells(
  line: string,
  bounds: Array<[number, number]>,
  cells: string[],
  header = false,
): string {
  const start = bounds[0][0];
  const end = bounds[bounds.length - 1][1];
  // Explicit edges disambiguate empty cells introduced by structural edits.
  const needsLeft = !cells[0].trim() || /^(?: {4}| *\t)/.test(cells[0]) ||
    (header && cells.length === 1 && end === line.length);
  const left = start ? line.slice(0, start) : needsLeft ? '|' : '';
  const right = end < line.length ? line.slice(end) : cells.at(-1)?.trim() ? '' : '|';
  return left + cells.join('|') + right;
}

/** Keep the raw content and padding of cells surviving an edit. */
export function preserveTableSource(
  table: Node,
  renderCell: (cell: Node) => string,
): string | null {
  const source = sources.get(table);
  if (!source) return null;
  const { original, lines, newline, originalRows, originalColumns } = source;
  if (table.eq(original)) return lines.join(newline);
  if (!isMarkdownTable(table)) return null;

  const header = table.firstChild!;
  const oldHeader = original.firstChild!;
  if ((!originalRows && table.childCount !== original.childCount) ||
      (!originalColumns && header.childCount !== oldHeader.childCount)) return null;
  const oldSeparator = lines[1];
  const separators = tableSourceCellsWithPadding(oldSeparator);
  if (separators.length !== oldHeader.childCount) return null;

  const columns = Array.from({ length: header.childCount }, (_, index) =>
    sourceIndex(originalColumns, index));
  const separatorCells = columns.map((oldIndex, index) => {
    const align = header.child(index).attrs.align;
    const raw = oldIndex === undefined ? ' --- ' : separators[oldIndex];
    if (oldIndex !== undefined && align === oldHeader.child(oldIndex).attrs.align) return raw;
    const dashes = raw.match(/-+/)?.[0] ?? '---';
    const left = align === 'left' || align === 'center' ? ':' : '';
    const right = align === 'right' || align === 'center' ? ':' : '';
    return edgeSpace(raw, true) + left + dashes + right + edgeSpace(raw, false);
  });
  const separator = joinCells(oldSeparator, cellBounds(oldSeparator), separatorCells);
  const columnsUnchanged = columns.length === oldHeader.childCount &&
    columns.every((previous, index) => previous === index);

  const result: string[] = [];
  for (let row = 0; row < table.childCount; row++) {
    const next = table.child(row);
    const oldIndex = sourceIndex(originalRows, row);
    if (oldIndex === undefined) {
      const cells = separatorCells.map((template, col) => paddedCell(next.child(col), template, renderCell));
      const bounds = cellBounds(separator);
      result.push(joinCells(separator, bounds, cells, row === 0));
      continue;
    }
    const prev = original.child(oldIndex);
    const line = lines[oldIndex === 0 ? 0 : oldIndex + 1];
    if (next.eq(prev) && columnsUnchanged) {
      result.push(line);
      continue;
    }
    const bounds = cellBounds(line);
    const rawCells = bounds.map(([from, to]) => line.slice(from, to));

    const cells = columns.map((previous, col) => {
      const cell = next.child(col);
      const raw = previous === undefined ? undefined : rawCells[previous];
      if (raw === undefined) return paddedCell(cell, separatorCells[col], renderCell);
      if (cell.content.eq(prev.child(previous!).content)) return raw;
      return edgeSpace(raw, true) + renderCell(cell) + (raw.trim() ? edgeSpace(raw, false) : '');
    });
    // A body row may omit trailing cells or contain additional cells ignored by GFM.
    // Keep ignored source cells in place when editing the modeled columns.
    const extraCells = row > 0 ? rawCells.slice(prev.childCount) : [];
    result.push(joinCells(line, bounds, cells.concat(extraCells), row === 0));
  }
  result.splice(1, 0, separator);
  return result.join(newline);
}

function tableSourceCellsWithPadding(line: string): string[] {
  return cellBounds(line).map(([from, to]) => line.slice(from, to));
}

export function tableSourceCells(line: string): string[] {
  return tableSourceCellsWithPadding(line).map((cell) => cell.trim());
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
