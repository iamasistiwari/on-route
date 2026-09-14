import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { propertyValueAt, selectionCopyText, stringContentAt } from './jsonCopy';

const doc = `{
  "url": "https://x.dev/a?b=1&c=\\"q\\"",
  "size": 12,
  "nested": { "a": [1, 2] }
}`;
const state = EditorState.create({ doc, extensions: [json()] });
const at = (needle: string, offset = 1) => doc.indexOf(needle) + offset;

describe('propertyValueAt', () => {
  it('copies decoded string values, scalars and pretty containers', () => {
    expect(propertyValueAt(state, at('"url"'))).toEqual({ key: 'url', text: 'https://x.dev/a?b=1&c="q"' });
    expect(propertyValueAt(state, at('"size"'))).toEqual({ key: 'size', text: '12' });
    expect(propertyValueAt(state, at('"nested"'))?.text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  });

  it('ignores positions outside keys', () => {
    expect(propertyValueAt(state, at('12'))).toBeNull();
  });
});

describe('stringContentAt', () => {
  it('selects the text between the quotes of a value', () => {
    const r = stringContentAt(state, at('https'))!;
    expect(doc.slice(r.from, r.to)).toBe('https://x.dev/a?b=1&c=\\"q\\"');
  });
});

describe('selectionCopyText', () => {
  it('drops the quotes of a fully selected string', () => {
    const from = doc.indexOf('"https');
    const to = doc.indexOf('",\n  "size"') + 1;
    expect(selectionCopyText(state, from, to)).toBe('https://x.dev/a?b=1&c="q"');
  });

  it('keeps partial selections as written', () => {
    expect(selectionCopyText(state, at('https', 0), at('https', 5))).toBe('https');
    expect(selectionCopyText(state, at('"size"', 0), at('12', 2))).toBe('"size": 12');
  });
});
