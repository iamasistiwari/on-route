// JSON-aware copy helpers for the body editors: what a double-click or a held selection should copy.
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

function tree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
}

/** The innermost node of `name` covering `pos` (either side), if any. */
function nodeAt(state: EditorState, pos: number, name: string): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === name) return n;
    }
  }
  return null;
}

/** Decoded text of a JSON value node: strings unquoted, containers pretty-printed, scalars as written. */
function valueText(state: EditorState, node: SyntaxNode): string {
  const src = state.sliceDoc(node.from, node.to);
  try {
    const v: unknown = JSON.parse(src);
    if (typeof v === 'string') return v;
    if (v !== null && typeof v === 'object') return JSON.stringify(v, null, 2);
  } catch {
    // Unfinished or invalid JSON (the request editor): copy the source as is.
  }
  return node.name === 'String' && src.length >= 2 && src.endsWith('"') ? src.slice(1, -1) : src;
}

/** Double-click on an object key: the key and the decoded text of its value. */
export function propertyValueAt(state: EditorState, pos: number): { key: string; text: string } | null {
  const name = nodeAt(state, pos, 'PropertyName');
  const prop = name?.parent;
  if (!name || prop?.name !== 'Property') return null;
  // Property { PropertyName ":" value } — the value is the last child (absent while typing).
  const value = prop.lastChild;
  if (!value || value.from === name.from || value.name === ':' || value.name === '⚠') return null;
  return { key: valueText(state, name), text: valueText(state, value) };
}

/** Range between the quotes of the string value under `pos` (not keys), for double-click selection. */
export function stringContentAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const s = nodeAt(state, pos, 'String');
  if (!s || s.to - s.from < 2) return null;
  return { from: s.from + 1, to: s.to - 1 };
}

/**
 * Text to copy for a selection: a selection edge sitting on a string's quote is moved inside it, so
 * selecting `"https://…"` copies the URL without the quotes. Escapes of a whole string are decoded.
 */
export function selectionCopyText(state: EditorState, from: number, to: number): string {
  if (from === to) return '';
  const start = nodeAt(state, from, 'String');
  if (start && start.from === from && start.to > from + 1) from++;
  const end = nodeAt(state, to, 'String');
  if (end && end.to === to && end.from < to - 1) to--;
  const text = state.sliceDoc(from, to);
  const whole = start && end && start.from === end.from && from === start.from + 1 && to === start.to - 1;
  if (whole) {
    try {
      return JSON.parse(`"${text}"`) as string;
    } catch {
      return text;
    }
  }
  return text;
}
