import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { getMathRenderer } from '../renderers';

/** The source editor handles caret entry. This node view only renders the formula. */
export class MathInlineNodeView {
  readonly dom: HTMLElement;
  private renderId = 0;

  constructor(private node: ProseMirrorNode) {
    this.dom = document.createElement('span');
    this.dom.className = 'math-inline';
    this.dom.contentEditable = 'false';
    void this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.tex !== this.node.attrs.tex;
    this.node = node;
    if (changed) void this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.renderId++;
  }

  private async render(): Promise<void> {
    const request = ++this.renderId;
    const tex = this.node.attrs.tex as string;
    this.dom.dataset.tex = tex;
    this.dom.textContent = tex ? `$${tex}$` : '';
    const renderer = getMathRenderer();
    if (!tex || !renderer) return;
    try {
      const result = await renderer.render(tex, { displayMode: false });
      if (request === this.renderId && !result.error) this.dom.innerHTML = result.html;
    } catch {
      // The Markdown formula is already present as a fallback.
    }
  }
}
