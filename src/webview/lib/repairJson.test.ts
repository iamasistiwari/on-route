import { describe, expect, it } from 'vitest';
import { repairJson } from './format';

const fix = (s: string) => repairJson(s);
const parsed = (s: string) => JSON.parse(fix(s)!.text);

describe('repairJson', () => {
  it('leaves valid JSON unflagged', () => {
    expect(fix('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', fixed: false });
  });
  it('drops a doubled closing quote', () => {
    expect(fix('{\n  "value": "hello word""\n}')).toEqual({ text: '{\n  "value": "hello word"\n}', fixed: true });
    expect(parsed('{"a": "x"", "b": "y""}')).toEqual({ a: 'x', b: 'y' });
  });
  it('keeps real empty strings', () => {
    expect(parsed('{"a": "", "b": ""}')).toEqual({ a: '', b: '' });
  });
  it('fixes commas', () => {
    expect(parsed('{"a": 1 "b": 2}')).toEqual({ a: 1, b: 2 });
    expect(parsed('{"a": 1,, "b": 2,}')).toEqual({ a: 1, b: 2 });
    expect(parsed('{, "a": 1}')).toEqual({ a: 1 });
    expect(parsed('[1 2 3]')).toEqual([1, 2, 3]);
  });
  it('fixes quotes and keys', () => {
    expect(parsed("{name: 'bob', 'age': 3}")).toEqual({ name: 'bob', age: 3 });
    expect(parsed('{“name”: “bob \"b\"”}')).toEqual({ name: 'bob "b"' });
    expect(parsed('{"msg": "he said "hi" ok"}')).toEqual({ msg: 'he said "hi" ok' });
  });
  it('fixes brackets and literals', () => {
    expect(parsed('{"a": [1, 2')).toEqual({ a: [1, 2] });
    expect(parsed('{"a": 1}}')).toEqual({ a: 1 });
    expect(parsed('{"a": True, "b": None, "c": False}')).toEqual({ a: true, b: null, c: false });
    expect(parsed('{"a": "unterminated')).toEqual({ a: 'unterminated' });
  });
  it('keeps {{variables}} while repairing', () => {
    expect(fix('{"id": {{userId}} "name": "{{name}}",}')!.text).toBe('{\n  "id": {{userId}},\n  "name": "{{name}}"\n}');
  });
  it('refuses to turn plain text into JSON', () => {
    expect(fix('hello world')).toBeNull();
    expect(fix('   ')).toBeNull();
  });
});
