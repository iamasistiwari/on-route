// Command-line and wire-format targets: raw HTTP, wget, HTTPie, PowerShell.
import type { ResolvedRequest } from '../model';
import { shellQuote } from './curl';
import { baseName, contentType, mergedHeaders, requestHeaders, splitUrl, textBody, urlEncodeFields } from './common';

const BOUNDARY = '----OnRouteFormBoundary';

/** Raw HTTP/1.1 message (as used by .http files). File contents are referenced with `< path`. */
export function toHttp(req: ResolvedRequest): string {
  const { host, path } = splitUrl(req.url);
  const lines = [`${req.method} ${path} HTTP/1.1`];
  if (!req.headers.some((h) => h.key.toLowerCase() === 'host')) lines.push(`Host: ${host}`);
  const body = req.body;
  for (const h of requestHeaders(req)) lines.push(`${h.key}: ${h.value}`);

  switch (body.type) {
    case 'text':
      lines.push('', textBody(req));
      break;
    case 'urlencoded':
      if (!contentType(req)) lines.push('Content-Type: application/x-www-form-urlencoded');
      lines.push('', urlEncodeFields(body.fields));
      break;
    case 'form':
      lines.push(`Content-Type: multipart/form-data; boundary=${BOUNDARY}`, '');
      for (const f of body.fields) {
        lines.push(`--${BOUNDARY}`);
        if (f.kind === 'file') {
          lines.push(`Content-Disposition: form-data; name="${f.key}"; filename="${baseName(f.value)}"`, '', `< ${f.value}`);
        } else {
          lines.push(`Content-Disposition: form-data; name="${f.key}"`, '', f.value);
        }
      }
      lines.push(`--${BOUNDARY}--`);
      break;
    case 'binary':
      lines.push('', `< ${body.filePath}`);
      break;
    case 'none':
      break;
  }
  return lines.join('\n');
}

export function toWget(req: ResolvedRequest): string {
  const body = req.body;
  const parts = ['wget --quiet', `--method ${req.method}`];
  for (const h of requestHeaders(req)) parts.push('--header ' + shellQuote(`${h.key}: ${h.value}`));
  const pre: string[] = [];
  switch (body.type) {
    case 'text':
      parts.push('--body-data ' + shellQuote(textBody(req)));
      break;
    case 'urlencoded':
      if (!contentType(req)) parts.push('--header ' + shellQuote('Content-Type: application/x-www-form-urlencoded'));
      parts.push('--body-data ' + shellQuote(urlEncodeFields(body.fields)));
      break;
    case 'form':
      pre.push('# wget cannot build multipart/form-data bodies; use cURL or HTTPie for this request.');
      break;
    case 'binary':
      parts.push('--body-file ' + shellQuote(body.filePath));
      break;
    case 'none':
      break;
  }
  parts.push('--output-document -', shellQuote(req.url));
  return [...pre, parts.join(' \\\n  ')].join('\n');
}

export function toHttpie(req: ResolvedRequest): string {
  const body = req.body;
  const flags: string[] = [];
  const items: string[] = [];
  let stdin = '';
  switch (body.type) {
    case 'text':
      flags.push('--raw ' + shellQuote(textBody(req)));
      break;
    case 'urlencoded':
      flags.push('--form');
      for (const f of body.fields) items.push(shellQuote(`${f.key}=${f.value}`));
      break;
    case 'form':
      flags.push('--multipart');
      for (const f of body.fields) items.push(shellQuote(f.kind === 'file' ? `${f.key}@${f.value}` : `${f.key}=${f.value}`));
      break;
    case 'binary':
      stdin = ' < ' + shellQuote(body.filePath);
      break;
    case 'none':
      break;
  }
  const headers = requestHeaders(req).map((h) => shellQuote(h.value === '' ? `${h.key};` : `${h.key}:${h.value}`));
  const parts = [['http', ...flags, req.method, shellQuote(req.url)].join(' '), ...headers, ...items];
  return parts.join(' \\\n  ') + stdin;
}

/** PowerShell single-quoted literal; a here-string when the value spans lines. */
function psString(s: string): string {
  if (s.includes('\n') && !/^'@/m.test(s)) return `@'\n${s}\n'@`;
  return "'" + s.replace(/'/g, "''") + "'";
}

export function toPowerShell(req: ResolvedRequest): string {
  const body = req.body;
  const lines: string[] = [];
  const args = [`-Uri ${psString(req.url)}`, `-Method ${req.method}`];
  const ct = contentType(req);
  const headers = mergedHeaders(req, { dropContentType: true });
  if (headers.length) {
    lines.push('$headers = @{');
    for (const h of headers) lines.push(`    ${psString(h.key)} = ${psString(h.value)}`);
    lines.push('}');
    args.push('-Headers $headers');
  }
  switch (body.type) {
    case 'text':
      lines.push(`$body = ${psString(textBody(req))}`);
      args.push('-Body $body');
      if (ct) args.push(`-ContentType ${psString(ct)}`);
      break;
    case 'urlencoded':
      lines.push(`$body = ${psString(urlEncodeFields(body.fields))}`);
      args.push('-Body $body', `-ContentType ${psString(ct ?? 'application/x-www-form-urlencoded')}`);
      break;
    case 'form':
      lines.push('$form = @{');
      for (const f of body.fields) {
        lines.push(`    ${psString(f.key)} = ${f.kind === 'file' ? `Get-Item -Path ${psString(f.value)}` : psString(f.value)}`);
      }
      lines.push('}');
      args.push('-Form $form');
      break;
    case 'binary':
      args.push(`-InFile ${psString(body.filePath)}`);
      if (ct) args.push(`-ContentType ${psString(ct)}`);
      break;
    case 'none':
      break;
  }
  if (lines.length) lines.push('');
  lines.push(`$response = Invoke-RestMethod ${args.join(' `\n    ')}`, '$response | ConvertTo-Json -Depth 10', '');
  return lines.join('\n');
}
