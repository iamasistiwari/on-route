import { describe, expect, it } from 'vitest';
import { decodeBase64Paste } from './base64Paste';

const b64 = (s: string) => btoa(s);
const jpegHead = btoa('ÿØÿà' + '\u0000'.repeat(300));
const pngHead = btoa('\u0089PNG\r\n\u001a\n' + '\u0000'.repeat(300));

describe('decodeBase64Paste · what it ignores', () => {
  it('leaves ordinary pastes alone', () => {
    expect(decodeBase64Paste('https://api.test/users')).toBeNull();
    expect(decodeBase64Paste('')).toBeNull();
    expect(decodeBase64Paste('   ')).toBeNull();
  });

  it('leaves short base64-looking tokens alone', () => {
    expect(decodeBase64Paste(b64('a short secret'))).toBeNull();
    expect(decodeBase64Paste('A'.repeat(64))).toBeNull();
  });

  it('leaves text carrying base64-illegal characters alone', () => {
    expect(decodeBase64Paste(`${'A'.repeat(300)}?x=1`)).toBeNull();
    expect(decodeBase64Paste(`eyJhbGciOiJIUzI1NiJ9.${'A'.repeat(300)}.sig`)).toBeNull();
  });
});

describe('decodeBase64Paste · media', () => {
  it('recognises a bare jpeg blob', () => {
    const result = decodeBase64Paste(jpegHead);
    expect(result).toMatchObject({ ok: true, kind: 'media', media: { kind: 'image', mime: 'image/jpeg' } });
  });

  it('accepts whitespace and line breaks inside the blob', () => {
    const wrapped = pngHead.replace(/(.{40})/g, '$1\n');
    expect(decodeBase64Paste(wrapped)).toMatchObject({ ok: true, kind: 'media', media: { mime: 'image/png' } });
  });

  it('unwraps quotes, which is how a blob arrives from JSON or a shell', () => {
    for (const quoted of [`"${jpegHead}"`, `'${jpegHead}'`, `\`${jpegHead}\``, `"${jpegHead}`, `${jpegHead}"`]) {
      expect(decodeBase64Paste(quoted)).toMatchObject({ ok: true, kind: 'media', media: { mime: 'image/jpeg' } });
    }
  });

  it('reads a data: URL and trusts its declared type', () => {
    const result = decodeBase64Paste(`data:image/jpeg;base64,${jpegHead}`);
    expect(result).toMatchObject({ ok: true, kind: 'media', media: { kind: 'image', mime: 'image/jpeg' } });
  });

  it('reports the decoded byte count, not the base64 length', () => {
    const result = decodeBase64Paste(jpegHead);
    expect(result).toMatchObject({ bytes: 304 });
  });

  it('keeps a capped head of the blob for the URL bar', () => {
    const long = btoa('\u00ff\u00d8\u00ff\u00e0' + 'x'.repeat(2000));
    expect(long.length).toBeGreaterThan(512);
    expect(decodeBase64Paste(long)).toMatchObject({ source: { head: long.slice(0, 512), length: long.length } });
  });
});

describe('decodeBase64Paste · text', () => {
  it('falls back to text when the bytes are readable', () => {
    const json = JSON.stringify({ hello: 'world', items: Array.from({ length: 100 }, (_, i) => `item-${i}`) });
    expect(decodeBase64Paste(btoa(json))).toMatchObject({ ok: true, kind: 'text', text: json });
  });
});

describe('decodeBase64Paste · failure', () => {
  it('reports base64 that does not decode', () => {
    expect(decodeBase64Paste('A'.repeat(301))).toMatchObject({ ok: false, message: 'Not valid base64' });
  });

  it('reports bytes it can neither play nor read', () => {
    const noise = String.fromCharCode(...Array.from({ length: 300 }, (_, i) => (i * 7) % 256));
    const result = decodeBase64Paste(btoa(noise));
    expect(result).toMatchObject({ ok: false, message: 'Not a recognised format' });
  });
});
