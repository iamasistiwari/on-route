// OWNER: agent "curl-codegen".
import type { ResolvedRequest } from '../model';
import { parseJsonSafely } from './common';

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** JS single-quoted string literal. */
export function jsString(s: string): string {
  return (
    "'" +
    s.replace(/[\\'\n\r\t\u2028\u2029\0\b\f\v]/g, (c) => {
      switch (c) {
        case '\\': return '\\\\';
        case "'": return "\\'";
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '\t': return '\\t';
        case '\0': return '\\x00';
        case '\b': return '\\b';
        case '\f': return '\\f';
        case '\v': return '\\v';
        default: return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      }
    }).replace(/[\x01-\x07\x0e-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) +
    "'"
  );
}

export function jsKey(k: string): string {
  return IDENT_RE.test(k) ? k : jsString(k);
}

/** Serialize a JSON value as an idiomatic JS literal at the given indent depth (2 spaces). */
export function jsLiteral(v: unknown, depth: number): string {
  const pad = '  '.repeat(depth + 1);
  const end = '  '.repeat(depth);
  if (v === null) return 'null';
  if (typeof v === 'string') return jsString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map((x) => pad + jsLiteral(x, depth + 1) + ',\n').join('') + end + ']';
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  return '{\n' + entries.map(([k, x]) => `${pad}${jsKey(k)}: ${jsLiteral(x, depth + 1)},\n`).join('') + end + '}';
}

/**
 * Generate a runnable axios snippet (ESM `import axios from 'axios'`), using `await axios.request({...})`.
 * JSON text bodies are emitted as object literals when parseable, else as strings.
 * urlencoded => URLSearchParams, form => FormData (file fields via fs.createReadStream comment),
 * binary => fs.createReadStream. Query params stay in the url string.
 */
export function toAxios(req: ResolvedRequest): string {
  const imports = ["import axios from 'axios';"];
  const pre: string[] = [];
  const body = req.body;
  let dataProp: string | undefined;

  switch (body.type) {
    case 'text': {
      const isJsonCt = /json/i.test(body.contentType ?? '') ||
        req.headers.some((h) => h.key.toLowerCase() === 'content-type' && /json/i.test(h.value));
      const parsed = parseJsonSafely(body.content);
      if (parsed.ok && (isJsonCt || !body.contentType)) {
        dataProp = `data: ${jsLiteral(parsed.value, 0)},`;
      } else if (body.content !== '') {
        dataProp = `data: ${jsString(body.content)},`;
      }
      break;
    }
    case 'urlencoded':
      pre.push('const data = new URLSearchParams();');
      for (const f of body.fields) pre.push(`data.append(${jsString(f.key)}, ${jsString(f.value)});`);
      dataProp = 'data,';
      break;
    case 'form': {
      const hasFile = body.fields.some((f) => f.kind === 'file');
      if (hasFile) {
        imports.push("import FormData from 'form-data'; // npm install form-data (Node.js)");
        imports.push("import fs from 'node:fs';");
      }
      pre.push('const data = new FormData();');
      for (const f of body.fields) {
        if (f.kind === 'file') pre.push(`data.append(${jsString(f.key)}, fs.createReadStream(${jsString(f.value)}));`);
        else pre.push(`data.append(${jsString(f.key)}, ${jsString(f.value)});`);
      }
      dataProp = 'data,';
      break;
    }
    case 'binary':
      imports.push("import fs from 'node:fs';");
      dataProp = `data: fs.createReadStream(${jsString(body.filePath)}),`;
      break;
    case 'none':
      break;
  }

  // Merge duplicate header names (object keys must be unique).
  const headers: { key: string; value: string }[] = [];
  for (const h of req.headers) {
    if (body.type === 'form' && h.key.toLowerCase() === 'content-type' && /^\s*multipart\/form-data\s*$/i.test(h.value)) {
      continue; // let axios/FormData set the boundary
    }
    const existing = headers.find((x) => x.key === h.key);
    if (existing) existing.value += (h.key.toLowerCase() === 'cookie' ? '; ' : ', ') + h.value;
    else headers.push({ ...h });
  }

  const props: string[] = [`method: ${jsString(req.method.toLowerCase())},`, `url: ${jsString(req.url)},`];
  if (headers.length) {
    props.push('headers: {');
    for (const h of headers) props.push(`  ${jsKey(h.key)}: ${jsString(h.value)},`);
    props.push('},');
  }
  if (dataProp) props.push(...dataProp.split('\n'));

  const lines = [
    ...imports,
    '',
    ...(pre.length ? [...pre, ''] : []),
    'const response = await axios.request({',
    ...props.map((p) => '  ' + p),
    '});',
    '',
    'console.log(response.data);',
    '',
  ];
  return lines.join('\n');
}
