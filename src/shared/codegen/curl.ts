// OWNER: agent "curl-codegen".
import type { ResolvedRequest } from '../model';

export interface CurlOptions {
  /** One flag per line joined with " \\\n  ". Default true. */
  multiline?: boolean;
}

/** Single-quote for POSIX shells: ' becomes '\''. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** Quote a -F file path when curl would otherwise misinterpret ; , or ". */
function formFilePath(path: string): string {
  return /[;,"]/.test(path) ? '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : path;
}

/**
 * Generate a POSIX-shell-safe curl command. Omit -X for GET (and for POST when a body is present).
 * Single-quote args, escaping ' as '\''. Body: text => --data-raw, urlencoded => --data-urlencode per
 * field, form => -F 'k=v' / -F 'k=@path', binary => --data-binary '@path'.
 */
export function toCurl(req: ResolvedRequest, opts: CurlOptions = {}): string {
  const multiline = opts.multiline !== false;
  const body = req.body;
  const hasBody = body.type !== 'none';

  const first: string[] = ['curl'];
  const omitX = (req.method === 'GET' && !hasBody) || (req.method === 'POST' && hasBody);
  if (!omitX) first.push('-X', req.method);
  first.push(shellQuote(req.url));

  const parts: string[] = [first.join(' ')];

  for (const h of req.headers) {
    // curl -F generates its own multipart boundary; a boundary-less override would break it.
    if (
      body.type === 'form' &&
      h.key.toLowerCase() === 'content-type' &&
      /^\s*multipart\/form-data\s*$/i.test(h.value)
    ) {
      continue;
    }
    parts.push('-H ' + shellQuote(h.value === '' ? `${h.key};` : `${h.key}: ${h.value}`));
  }

  switch (body.type) {
    case 'text':
      parts.push('--data-raw ' + shellQuote(body.content));
      break;
    case 'urlencoded':
      for (const f of body.fields) parts.push('--data-urlencode ' + shellQuote(`${f.key}=${f.value}`));
      break;
    case 'form':
      for (const f of body.fields) {
        if (f.kind === 'file') parts.push('-F ' + shellQuote(`${f.key}=@${formFilePath(f.value)}`));
        else if (/^[@<]|;/.test(f.value)) parts.push('--form-string ' + shellQuote(`${f.key}=${f.value}`));
        else parts.push('-F ' + shellQuote(`${f.key}=${f.value}`));
      }
      break;
    case 'binary':
      parts.push('--data-binary ' + shellQuote('@' + body.filePath));
      break;
    case 'none':
      break;
  }

  return parts.join(multiline ? ' \\\n  ' : ' ');
}
