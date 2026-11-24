/** Shared DOM primitives; editing/commit ownership stays with the caller. */
export function createInlineMathInput(doc: Document, value: string): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'math-inline-input';
  input.contentEditable = 'true';
  input.value = value;
  return input;
}
