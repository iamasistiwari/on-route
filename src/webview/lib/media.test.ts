import { describe, expect, it } from 'vitest';
import { detectMedia, suggestedFileName } from './media';

/** First bytes of a file, as the base64 head of a response body. */
const head = (...bytes: (number | string)[]) => {
  const flat: number[] = [];
  for (const b of bytes) {
    if (typeof b === 'number') flat.push(b);
    else for (const c of b) flat.push(c.charCodeAt(0));
  }
  while (flat.length % 3 !== 0) flat.push(0);
  return btoa(String.fromCharCode(...flat));
};

describe('detectMedia · content type', () => {
  it('reads the type, ignoring parameters and case', () => {
    expect(detectMedia('IMAGE/PNG', undefined)).toEqual({ kind: 'image', mime: 'image/png' });
    expect(detectMedia('application/pdf; qs=0.001', undefined)).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(detectMedia('video/mp4', undefined)).toEqual({ kind: 'video', mime: 'video/mp4' });
  });

  it('handles the vendor-prefixed and container types servers actually send', () => {
    expect(detectMedia('audio/x-wav', undefined)).toEqual({ kind: 'audio', mime: 'audio/wav' });
    expect(detectMedia('application/ogg', undefined)).toEqual({ kind: 'audio', mime: 'audio/ogg' });
    expect(detectMedia('application/ogg', 'https://x.test/clip.ogv')).toEqual({ kind: 'video', mime: 'video/ogg' });
    expect(detectMedia('application/mp4', undefined)).toEqual({ kind: 'video', mime: 'video/mp4' });
  });

  it('treats an unknown type as binary', () => {
    expect(detectMedia('application/zip', undefined)).toEqual({ kind: 'binary', mime: 'application/zip' });
  });
});

describe('detectMedia · url', () => {
  it('falls back to the extension when the server sends a generic type', () => {
    const url = 'https://cdn2.bensound.com/bensound-slowlife.mp3?token=eyJhbGciOiJIUzI1NiJ9.abc';
    expect(detectMedia('application/octet-stream', url)).toEqual({ kind: 'audio', mime: 'audio/mpeg' });
    expect(detectMedia(undefined, 'https://x.test/a/b/clip.WEBM#t=2')).toEqual({ kind: 'video', mime: 'video/webm' });
    expect(detectMedia('binary/octet-stream', 'https://x.test/doc.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('ignores an extension-looking query when the path has none', () => {
    expect(detectMedia(undefined, 'https://x.test/download?file=song.mp3')).toEqual({ kind: 'binary', mime: 'application/octet-stream' });
  });

  it('keeps a specific content type over the extension', () => {
    expect(detectMedia('image/png', 'https://x.test/thumb.mp3')).toEqual({ kind: 'image', mime: 'image/png' });
  });
});

describe('detectMedia · magic bytes', () => {
  const cases: [string, string, string][] = [
    ['%PDF-1.4', 'pdf', 'application/pdf'],
    ['ID3\u0003', 'audio', 'audio/mpeg'],
    ['OggS\u0000', 'audio', 'audio/ogg'],
    ['fLaC', 'audio', 'audio/flac'],
    ['\u0089PNG\r\n', 'image', 'image/png'],
    ['GIF89a', 'image', 'image/gif'],
  ];
  it.each(cases)('sniffs %s', (magic, kind, mime) => {
    expect(detectMedia('application/octet-stream', 'https://x.test/blob', head(magic))).toEqual({ kind, mime });
  });

  it('separates the RIFF and ftyp containers by their sub-type', () => {
    expect(detectMedia(undefined, undefined, head('RIFF', 0, 0, 0, 0, 'WAVE'))).toEqual({ kind: 'audio', mime: 'audio/wav' });
    expect(detectMedia(undefined, undefined, head('RIFF', 0, 0, 0, 0, 'WEBP'))).toEqual({ kind: 'image', mime: 'image/webp' });
    expect(detectMedia(undefined, undefined, head(0, 0, 0, 0x20, 'ftypisom'))).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(detectMedia(undefined, undefined, head(0, 0, 0, 0x20, 'ftypM4A '))).toEqual({ kind: 'audio', mime: 'audio/mp4' });
  });

  it('gives up on bytes it does not know', () => {
    expect(detectMedia(undefined, undefined, head('not a known header'))).toEqual({ kind: 'binary', mime: 'application/octet-stream' });
    expect(detectMedia(undefined, undefined, '')).toEqual({ kind: 'binary', mime: 'application/octet-stream' });
  });
});

describe('suggestedFileName', () => {
  it('uses the url basename when it already has an extension', () => {
    expect(suggestedFileName('https://cdn.test/a/bensound-slowlife.mp3?token=x', 'audio/mpeg')).toBe('bensound-slowlife.mp3');
  });

  it('names the file from the type otherwise', () => {
    expect(suggestedFileName('https://x.test/download?id=9', 'audio/mpeg')).toBe('download.mp3');
    expect(suggestedFileName(undefined, 'video/mp4')).toBe('response.mp4');
    expect(suggestedFileName('https://x.test/', 'application/octet-stream')).toBe('response.bin');
  });
});
