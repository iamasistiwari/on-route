import { describe, expect, it } from 'vitest';
import type { VariableInfo } from '../../shared/protocol';
import { applyCompletion, completionRange, describeVar, resolvedKeys, suggestVariables, unresolvedNames, varAt } from './vars';

const info = (key: string, resolved = true): VariableInfo => ({ key, value: 'v', source: 'project', secret: false, resolved });

describe('completionRange', () => {
  it('opens right after {{', () => {
    expect(completionRange('Bearer {{', 9)).toEqual({ from: 7, to: 9, query: '' });
  });

  it('captures the partial name and allows spaces after braces', () => {
    expect(completionRange('{{ api', 6)).toEqual({ from: 0, to: 6, query: 'api' });
  });

  it('covers the rest of the name and an existing closing brace pair', () => {
    const text = '{{api-key}}/x';
    expect(completionRange(text, 5)).toEqual({ from: 0, to: 11, query: 'api' });
  });

  it('does not swallow unrelated text after the caret', () => {
    expect(completionRange('{{base/users', 6)).toEqual({ from: 0, to: 6, query: 'base' });
  });

  it('is null outside a reference', () => {
    expect(completionRange('{{a}} tail', 10)).toBeNull();
    expect(completionRange('plain', 3)).toBeNull();
  });
});

describe('applyCompletion', () => {
  it('inserts a closed reference and puts the caret after it', () => {
    const text = 'x {{ap y';
    const r = completionRange(text, 6)!;
    expect(applyCompletion(text, r, 'api-key')).toEqual({ text: 'x {{api-key}} y', caret: 13 });
  });

  it('replaces an existing reference instead of duplicating braces', () => {
    const text = '{{api}}';
    const r = completionRange(text, 4)!;
    expect(applyCompletion(text, r, 'apiKey').text).toBe('{{apiKey}}');
  });
});

describe('suggestVariables', () => {
  it('orders prefix matches before substring matches, case-insensitively', () => {
    const vars = [info('myApiKey'), info('apiUrl'), info('other')];
    expect(suggestVariables(vars, 'API').map((v) => v.key)).toEqual(['apiUrl', 'myApiKey']);
  });

  it('includes dynamic variables', () => {
    expect(suggestVariables([], '$u').map((v) => v.key)).toEqual(['$uuid']);
  });
});

describe('unresolvedNames', () => {
  it('reports undefined and value-less variables, not dynamic ones', () => {
    const keys = resolvedKeys([info('baseUrl'), info('secret', false)]);
    expect(unresolvedNames('{{baseUrl}}/{{api-key}}?t={{$timestamp}}&s={{secret}}', keys)).toEqual(['api-key', 'secret']);
  });
});

describe('varAt', () => {
  const text = '{{baseUrl}}/users/{{ id }}';

  it('finds the reference covering an index, braces included', () => {
    expect(varAt(text, 0)).toEqual({ name: 'baseUrl', from: 0, to: 11 });
    expect(varAt(text, 10)).toEqual({ name: 'baseUrl', from: 0, to: 11 });
    expect(varAt(text, 20)).toEqual({ name: 'id', from: 18, to: 26 });
  });

  it('is null between references, outside the text and for empty braces', () => {
    expect(varAt(text, 11)).toBeNull();
    expect(varAt(text, -1)).toBeNull();
    expect(varAt(text, 26)).toBeNull();
    expect(varAt('{{}}', 1)).toBeNull();
  });
});

describe('describeVar', () => {
  const vars: VariableInfo[] = [
    { key: 'baseUrl', value: 'http://localhost:3000', source: 'environment dev', secret: false, resolved: true },
    { key: 'blank', value: '', source: 'project', secret: false, resolved: true },
    { key: 'token', value: '', source: 'local', secret: true, resolved: true },
    { key: 'apiKey', value: '', source: 'project', secret: true, resolved: false },
  ];

  it('shows the value and its scope', () => {
    expect(describeVar('baseUrl', vars)).toEqual({ name: 'baseUrl', value: 'http://localhost:3000', source: 'environment dev', state: 'value' });
  });

  it('never reveals secrets', () => {
    expect(describeVar('token', vars)).toMatchObject({ value: '••••••', state: 'secret' });
    expect(describeVar('apiKey', vars)).toMatchObject({ state: 'unresolved' });
  });

  it('labels empty, dynamic and unknown variables', () => {
    expect(describeVar('blank', vars).state).toBe('empty');
    expect(describeVar('$uuid', vars).state).toBe('dynamic');
    expect(describeVar('nope', vars).state).toBe('unresolved');
    expect(describeVar('nope', vars).source).toBeUndefined();
  });
});

describe('spelling suggestions', () => {
  it('suggests the closest variable for a typo', () => {
    expect(describeVar('baseUlr', [info('baseUrl'), info('userId')]).suggestion).toBe('baseUrl');
    expect(describeVar('zzz', [info('baseUrl')]).suggestion).toBeUndefined();
  });

  it('autocomplete falls back to the closest spelling', () => {
    expect(suggestVariables([info('baseUrl'), info('userId')], 'baesUrl').map((v) => v.key)).toEqual(['baseUrl']);
  });
});
