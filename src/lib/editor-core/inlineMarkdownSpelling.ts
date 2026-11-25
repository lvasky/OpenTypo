import type { Fragment, Mark, Node } from 'prosemirror-model';

interface Spelling {
  source: string;
  linkOpen?: string;
  linkClose?: string;
}

const spellings = new WeakMap<Node | Mark, Spelling>();
const retained = new WeakSet<Node | Mark>();

export function rememberInlineMarkdownSpelling(node: Node | Mark, spelling: Spelling): void {
  spellings.set(node, spelling);
}

export function getInlineMarkdownSource(node: Node | Mark): string | undefined {
  return spellings.get(node)?.source;
}

/** Only a local, explicit source edit opts into literal spelling on serialization. */
export function retainInlineMarkdownSpelling(content: Fragment): void {
  content.descendants((node) => {
    if (spellings.has(node)) retained.add(node);
    for (const mark of node.marks) {
      if (spellings.has(mark)) retained.add(mark);
    }
  });
}

export function retainedInlineMarkdownSpelling(node: Node | Mark): Spelling | undefined {
  return retained.has(node) ? spellings.get(node) : undefined;
}
