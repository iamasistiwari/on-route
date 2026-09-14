// Scripting-language targets: JavaScript fetch, Python (requests, http.client), PHP (cURL, Guzzle), Ruby.
import type { ResolvedRequest } from '../model';
import { jsKey, jsLiteral, jsString } from './axios';
import {
  baseName,
  contentType,
  dq,
  hasUniqueKeys,
  jsonBody,
  mergedHeaders,
  requestHeaders,
  splitUrl,
  sq,
  textBody,
  urlEncodeFields,
  type Header,
} from './common';

// ---------- JavaScript fetch ----------

export function toFetch(req: ResolvedRequest): string {
  const body = req.body;
  const imports: string[] = [];
  const pre: string[] = [];
  let bodyProp: string | undefined;

  switch (body.type) {
    case 'text': {
      const parsed = jsonBody(req);
      bodyProp = parsed.ok ? `body: JSON.stringify(${jsLiteral(parsed.value, 1)}),` : `body: ${jsString(body.content)},`;
      break;
    }
    case 'urlencoded':
      pre.push('const body = new URLSearchParams();');
      for (const f of body.fields) pre.push(`body.append(${jsString(f.key)}, ${jsString(f.value)});`);
      bodyProp = 'body,';
      break;
    case 'form':
      if (body.fields.some((f) => f.kind === 'file')) imports.push("import { openAsBlob } from 'node:fs';");
      pre.push('const body = new FormData();');
      for (const f of body.fields) {
        pre.push(
          f.kind === 'file'
            ? `body.append(${jsString(f.key)}, await openAsBlob(${jsString(f.value)}), ${jsString(baseName(f.value))});`
            : `body.append(${jsString(f.key)}, ${jsString(f.value)});`,
        );
      }
      bodyProp = 'body,';
      break;
    case 'binary':
      imports.push("import { openAsBlob } from 'node:fs';");
      bodyProp = `body: await openAsBlob(${jsString(body.filePath)}),`;
      break;
    case 'none':
      break;
  }

  const headers = mergedHeaders(req);
  const opts: string[] = [`method: ${jsString(req.method)},`];
  if (headers.length) {
    opts.push('headers: {');
    for (const h of headers) opts.push(`  ${jsKey(h.key)}: ${jsString(h.value)},`);
    opts.push('},');
  }
  if (bodyProp) opts.push(...bodyProp.split('\n'));

  return [
    ...(imports.length ? [...imports, ''] : []),
    ...(pre.length ? [...pre, ''] : []),
    `const response = await fetch(${jsString(req.url)}, {`,
    ...opts.map((o) => '  ' + o),
    '});',
    '',
    'console.log(await response.text());',
    '',
  ].join('\n');
}

// ---------- Python ----------

function pyString(s: string): string {
  return dq(s, { unicode: 'x2' });
}

/** Python literal for a JSON value, 4-space indented. */
function pyLiteral(v: unknown, depth: number): string {
  const pad = '    '.repeat(depth + 1);
  const end = '    '.repeat(depth);
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return pyString(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map((x) => `${pad}${pyLiteral(x, depth + 1)},\n`).join('') + end + ']';
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  return '{\n' + entries.map(([k, x]) => `${pad}${pyString(k)}: ${pyLiteral(x, depth + 1)},\n`).join('') + end + '}';
}

function pyDict(fields: Header[]): string {
  if (!fields.length) return '{}';
  if (!hasUniqueKeys(fields)) return '[\n' + fields.map((f) => `    (${pyString(f.key)}, ${pyString(f.value)}),\n`).join('') + ']';
  return '{\n' + fields.map((f) => `    ${pyString(f.key)}: ${pyString(f.value)},\n`).join('') + '}';
}

export function toPythonRequests(req: ResolvedRequest): string {
  const body = req.body;
  const lines = ['import requests', '', `url = ${pyString(req.url)}`];
  const args = ['url'];
  const headers = mergedHeaders(req);
  if (headers.length) {
    lines.push('', `headers = ${pyDict(headers)}`);
    args.push('headers=headers');
  }
  switch (body.type) {
    case 'text': {
      const parsed = jsonBody(req);
      if (parsed.ok) {
        lines.push('', `payload = ${pyLiteral(parsed.value, 0)}`);
        args.push('json=payload');
      } else {
        lines.push('', `payload = ${pyString(body.content)}`);
        args.push('data=payload');
      }
      break;
    }
    case 'urlencoded':
      lines.push('', `payload = ${pyDict(body.fields)}`);
      args.push('data=payload');
      break;
    case 'form': {
      const text = body.fields.filter((f) => f.kind !== 'file');
      const files = body.fields.filter((f) => f.kind === 'file');
      if (text.length) {
        lines.push('', `payload = ${pyDict(text)}`);
        args.push('data=payload');
      }
      if (files.length) {
        lines.push('', 'files = [');
        for (const f of files) lines.push(`    (${pyString(f.key)}, open(${pyString(f.value)}, "rb")),`);
        lines.push(']');
        args.push('files=files');
      }
      break;
    }
    case 'binary':
      lines.push('', `payload = open(${pyString(body.filePath)}, "rb")`);
      args.push('data=payload');
      break;
    case 'none':
      break;
  }
  lines.push('', `response = requests.request(${pyString(req.method)}, ${args.join(', ')})`, '', 'print(response.text)', '');
  return lines.join('\n');
}

export function toPythonHttpClient(req: ResolvedRequest): string {
  const body = req.body;
  const { scheme, host, path } = splitUrl(req.url);
  const imports = ['import http.client'];
  const lines: string[] = [];
  const conn = scheme === 'http' ? 'HTTPConnection' : 'HTTPSConnection';
  lines.push(`conn = http.client.${conn}(${pyString(host)})`);
  const headers = mergedHeaders(req);
  let payload = 'None';

  switch (body.type) {
    case 'text': {
      const parsed = jsonBody(req);
      if (parsed.ok) {
        imports.push('import json');
        lines.push(`payload = json.dumps(${pyLiteral(parsed.value, 0)})`);
      } else {
        lines.push(`payload = ${pyString(body.content)}`);
      }
      payload = 'payload';
      break;
    }
    case 'urlencoded':
      imports.push('from urllib.parse import urlencode');
      lines.push(`payload = urlencode(${pyDict(body.fields)})`);
      if (!contentType(req)) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
      payload = 'payload';
      break;
    case 'form': {
      lines.push('boundary = "----OnRouteFormBoundary"', 'payload = b""');
      for (const f of body.fields) {
        const start = '("--" + boundary + "\\r\\n" + ';
        if (f.kind === 'file') {
          const head = `Content-Disposition: form-data; name="${f.key}"; filename="${baseName(f.value)}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
          lines.push(
            `with open(${pyString(f.value)}, "rb") as fh:`,
            `    payload += ${start}${pyString(head)}).encode() + fh.read() + b"\\r\\n"`,
          );
        } else {
          const part = `Content-Disposition: form-data; name="${f.key}"\r\n\r\n${f.value}\r\n`;
          lines.push(`payload += ${start}${pyString(part)}).encode()`);
        }
      }
      lines.push('payload += ("--" + boundary + "--\\r\\n").encode()');
      headers.push({ key: 'Content-Type', value: '__BOUNDARY__' });
      payload = 'payload';
      break;
    }
    case 'binary':
      lines.push(`with open(${pyString(body.filePath)}, "rb") as fh:`, '    payload = fh.read()');
      payload = 'payload';
      break;
    case 'none':
      break;
  }

  const headerLines = headers.map((h) =>
    h.value === '__BOUNDARY__'
      ? '    "Content-Type": "multipart/form-data; boundary=" + boundary,'
      : `    ${pyString(h.key)}: ${pyString(h.value)},`,
  );
  lines.push(headers.length ? `headers = {\n${headerLines.join('\n')}\n}` : 'headers = {}');
  lines.push(
    `conn.request(${pyString(req.method)}, ${pyString(path)}, ${payload}, headers)`,
    'res = conn.getresponse()',
    'print(res.read().decode("utf-8"))',
    '',
  );
  return [...imports, '', ...lines].join('\n');
}

// ---------- PHP ----------

function phpArray(entries: string[], depth: number): string {
  if (!entries.length) return '[]';
  const pad = '    '.repeat(depth + 1);
  return '[\n' + entries.map((e) => `${pad}${e},\n`).join('') + '    '.repeat(depth) + ']';
}

export function toPhpCurl(req: ResolvedRequest): string {
  const body = req.body;
  const opts = [
    `CURLOPT_URL => ${sq(req.url)}`,
    'CURLOPT_RETURNTRANSFER => true',
    'CURLOPT_FOLLOWLOCATION => true',
    `CURLOPT_CUSTOMREQUEST => ${sq(req.method)}`,
  ];
  switch (body.type) {
    case 'text':
      opts.push(`CURLOPT_POSTFIELDS => ${sq(textBody(req))}`);
      break;
    case 'urlencoded':
      opts.push(`CURLOPT_POSTFIELDS => ${sq(urlEncodeFields(body.fields))}`);
      break;
    case 'form':
      opts.push(
        `CURLOPT_POSTFIELDS => ${phpArray(
          body.fields.map((f) => `${sq(f.key)} => ${f.kind === 'file' ? `new CURLFile(${sq(f.value)})` : sq(f.value)}`),
          1,
        )}`,
      );
      break;
    case 'binary':
      opts.push(`CURLOPT_POSTFIELDS => file_get_contents(${sq(body.filePath)})`);
      break;
    case 'none':
      break;
  }
  const headers = requestHeaders(req);
  if (headers.length) opts.push(`CURLOPT_HTTPHEADER => ${phpArray(headers.map((h) => sq(`${h.key}: ${h.value}`)), 1)}`);

  return [
    '<?php',
    '',
    '$curl = curl_init();',
    '',
    `curl_setopt_array($curl, ${phpArray(opts, 0)});`,
    '',
    '$response = curl_exec($curl);',
    'curl_close($curl);',
    '',
    'echo $response;',
    '',
  ].join('\n');
}

export function toPhpGuzzle(req: ResolvedRequest): string {
  const body = req.body;
  const opts: string[] = [];
  const headers = mergedHeaders(req);
  if (headers.length) opts.push(`'headers' => ${phpArray(headers.map((h) => `${sq(h.key)} => ${sq(h.value)}`), 1)}`);
  switch (body.type) {
    case 'text':
      opts.push(`'body' => ${sq(textBody(req))}`);
      break;
    case 'urlencoded':
      opts.push(
        hasUniqueKeys(body.fields)
          ? `'form_params' => ${phpArray(body.fields.map((f) => `${sq(f.key)} => ${sq(f.value)}`), 1)}`
          : `'body' => ${sq(urlEncodeFields(body.fields))}`,
      );
      break;
    case 'form':
      opts.push(
        `'multipart' => ${phpArray(
          body.fields.map((f) =>
            f.kind === 'file'
              ? `['name' => ${sq(f.key)}, 'contents' => fopen(${sq(f.value)}, 'r'), 'filename' => ${sq(baseName(f.value))}]`
              : `['name' => ${sq(f.key)}, 'contents' => ${sq(f.value)}]`,
          ),
          1,
        )}`,
      );
      break;
    case 'binary':
      opts.push(`'body' => fopen(${sq(body.filePath)}, 'r')`);
      break;
    case 'none':
      break;
  }
  const call = opts.length
    ? `$response = $client->request(${sq(req.method)}, ${sq(req.url)}, ${phpArray(opts, 0)});`
    : `$response = $client->request(${sq(req.method)}, ${sq(req.url)});`;
  return [
    '<?php',
    '',
    "require 'vendor/autoload.php';",
    '',
    'use GuzzleHttp\\Client;',
    '',
    '$client = new Client();',
    call,
    '',
    'echo $response->getBody();',
    '',
  ].join('\n');
}

// ---------- Ruby ----------

const RUBY_CLASSES: Record<string, string> = {
  GET: 'Get',
  POST: 'Post',
  PUT: 'Put',
  PATCH: 'Patch',
  DELETE: 'Delete',
  HEAD: 'Head',
  OPTIONS: 'Options',
};

function rubyString(s: string): string {
  if (s.includes('\n') && !/^\s*BODY\s*$/m.test(s)) {
    return `<<~'BODY'.chomp\n${s
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')}\n  BODY`;
  }
  return sq(s);
}

export function toRubyNetHttp(req: ResolvedRequest): string {
  const body = req.body;
  const lines = ['require "uri"', 'require "net/http"', '', `url = URI(${sq(req.url)})`, ''];
  lines.push('http = Net::HTTP.new(url.host, url.port)', 'http.use_ssl = url.scheme == "https"', '');
  lines.push(`request = Net::HTTP::${RUBY_CLASSES[req.method] ?? 'Get'}.new(url)`);
  for (const h of requestHeaders(req)) lines.push(`request[${sq(h.key)}] = ${sq(h.value)}`);

  switch (body.type) {
    case 'text':
      lines.push(`request.body = ${rubyString(textBody(req))}`);
      break;
    case 'urlencoded':
      lines.push(`request.body = URI.encode_www_form([${body.fields.map((f) => `[${sq(f.key)}, ${sq(f.value)}]`).join(', ')}])`);
      break;
    case 'form':
      lines.push('form_data = [');
      for (const f of body.fields) {
        lines.push(`  [${sq(f.key)}, ${f.kind === 'file' ? `File.open(${sq(f.value)})` : sq(f.value)}],`);
      }
      lines.push(']', "request.set_form(form_data, 'multipart/form-data')");
      break;
    case 'binary':
      lines.push(`request.body = File.binread(${sq(body.filePath)})`);
      break;
    case 'none':
      break;
  }
  lines.push('', 'response = http.request(request)', 'puts response.read_body', '');
  return lines.join('\n');
}
