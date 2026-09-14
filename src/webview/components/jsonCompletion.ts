// CodeMirror completion for JSON bodies: property names (with a typical value) and values of known keys.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { JsonKeySuggestion } from '../lib/suggest';

const MAX_KEYS = 60;
const MAX_VALUES = 12;

/** Whether `text` ends inside a string literal, and the innermost unclosed bracket. */
function scan(text: string): { inString: boolean; open: '{' | '[' | undefined } {
  let inString = false;
  const stack: ('{' | '[')[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  return { inString, open: stack[stack.length - 1] };
}

export function jsonSuggestionSource(ref: { current: readonly JsonKeySuggestion[] | undefined }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const corpus = ref.current;
    if (!corpus?.length) return null;
    const before = ctx.state.sliceDoc(0, ctx.pos);

    // Value of a key seen before: "status": "act|
    const value = /"([\w$-]+)"\s*:\s*("(?:[^"\\\n]|\\.)*|[\w.+-]*)$/.exec(before);
    if (value && !scan(before.slice(0, value.index)).inString) {
      const entry = corpus.find((k) => k.key === value[1]);
      if (!entry?.values.length) return null;
      return {
        from: ctx.pos - value[2].length,
        options: entry.values.slice(0, MAX_VALUES).map((v, i) => ({ label: v, type: 'constant', boost: MAX_VALUES - i })),
        validFor: /^(?:"(?:[^"\\\n]|\\.)*|[\w.+-]*)$/,
      };
    }

    // Property name after "{" or "," in an object, optionally after its opening quote.
    const key = /[{,]\s*("?)([\w$-]*)$/.exec(before);
    if (!key) return null;
    const start = ctx.pos - key[2].length - key[1].length;
    const context = scan(before.slice(0, start));
    if (context.inString || context.open !== '{') return null;
    if (!key[1] && !key[2] && !ctx.explicit) return null;

    const present = new Set([...ctx.state.doc.toString().matchAll(/"([\w$-]+)"\s*:/g)].map((m) => m[1]));
    const options: Completion[] = corpus
      .filter((k) => !present.has(k.key))
      .slice(0, MAX_KEYS)
      .map((k, i) => ({
        label: k.key,
        type: 'property',
        boost: Math.max(-99, 60 - i),
        apply: (view: EditorView, _c: Completion, _from: number, to: number) => {
          const val = k.values[0] ?? '""';
          const end = view.state.sliceDoc(to, to + 1) === '"' ? to + 1 : to;
          const insert = `"${k.key}": ${val}`;
          // Put the cursor inside an empty string value, otherwise after the value.
          const anchor = start + insert.length - (val === '""' ? 1 : 0);
          view.dispatch({ changes: { from: start, to: end, insert }, selection: { anchor }, userEvent: 'input.complete' });
        },
      }));
    return { from: ctx.pos - key[2].length, options, validFor: /^[\w$-]*$/ };
  };
}
