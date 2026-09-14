// Deciding what a binary response actually is, so it can be shown as a picture or played back.
// Servers are unreliable here: CDNs hand out `application/octet-stream` for audio, so the URL and the
// leading bytes are consulted in turn when the Content-Type does not settle it.

export type MediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'binary';

export interface MediaInfo {
  kind: MediaKind;
  /** Type to hand to the <img>/<audio>/<video> element, or to save the file as. */
  mime: string;
}

const BINARY: MediaInfo = { kind: 'binary', mime: 'application/octet-stream' };

/** Types that say nothing beyond "bytes", so detection should keep looking. */
const GENERIC = /^(application\/(octet-stream|binary)|binary\/octet-stream)$/;

/** Extension -> the type to play it as. Everything else falls through to `binary`. */
const BY_EXTENSION: Record<string, string> = {
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  // image
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  // documents
  pdf: 'application/pdf',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

const kindOf = (mime: string): MediaKind =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : mime === 'application/pdf' ? 'pdf' : 'binary';

const info = (mime: string): MediaInfo => ({ kind: kindOf(mime), mime });

/** "audio/x-wav; charset=binary" -> "audio/wav". */
function normalizeType(contentType: string | undefined): string {
  const base = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const slash = base.indexOf('/');
  if (slash === -1) return base;
  const subtype = base.slice(slash + 1).replace(/^(x-|vnd\.)/, '');
  return `${base.slice(0, slash)}/${subtype}`;
}

/** Lowercase extension of the URL's path (query and fragment excluded), or "". */
function urlExtension(url: string | undefined): string {
  if (!url) return '';
  const path = url.split(/[?#]/, 1)[0];
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** First `count` bytes of a base64 body (the head is enough: signatures live in the first 16). */
function leadingBytes(base64: string, count = 16): number[] {
  if (!base64) return [];
  try {
    const binary = atob(base64.slice(0, Math.ceil(count / 3) * 4));
    return [...binary.slice(0, count)].map((c) => c.charCodeAt(0));
  } catch {
    return [];
  }
}

const ascii = (bytes: number[], from: number, length: number) =>
  String.fromCharCode(...bytes.slice(from, from + length));

/** Type from the file's own leading bytes, or "" when they are not a signature we know. */
function sniff(bytes: number[]): string {
  if (bytes.length < 4) return '';
  const magic = ascii(bytes, 0, 4);
  if (magic === '%PDF') return 'application/pdf';
  if (magic === 'OggS') return 'audio/ogg';
  if (magic === 'fLaC') return 'audio/flac';
  if (magic === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // A frame header rather than an ID3 tag: 11 set bits, then a known MPEG audio layer.
  if (bytes[0] === 0xff && (bytes[1] & 0xe6) >= 0xe2 && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (magic === 'RIFF') {
    const form = ascii(bytes, 8, 4);
    if (form === 'WAVE') return 'audio/wav';
    if (form === 'WEBP') return 'image/webp';
    if (form === 'AVI ') return 'video/x-msvideo';
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).trim();
    return brand.startsWith('M4A') || brand.startsWith('M4B') ? 'audio/mp4' : 'video/mp4';
  }
  return '';
}

/**
 * What a response body is, in decreasing order of trust: its Content-Type, the URL it came from, then its
 * leading bytes. `base64` is the response body as stored (only its head is read).
 */
export function detectMedia(contentType: string | undefined, url: string | undefined, base64 = ''): MediaInfo {
  const type = normalizeType(contentType);
  const extension = urlExtension(url);

  if (type && !GENERIC.test(type)) {
    // Container types that carry either audio or video; the extension breaks the tie, audio is the common case.
    if (type === 'application/ogg') return info(extension === 'ogv' ? 'video/ogg' : 'audio/ogg');
    if (type === 'application/mp4') return info(extension === 'm4a' ? 'audio/mp4' : 'video/mp4');
    return info(type);
  }

  const byExtension = BY_EXTENSION[extension];
  if (byExtension) return info(byExtension);

  const sniffed = sniff(leadingBytes(base64));
  if (sniffed) return info(sniffed);

  return type ? info(type) : BINARY;
}

/** Name to offer when saving the body: the URL's own file name, else one built from the type. */
export function suggestedFileName(url: string | undefined, mime: string): string {
  const path = (url ?? '').split(/[?#]/, 1)[0];
  const name = path.slice(path.lastIndexOf('/') + 1);
  const extension = EXTENSION_BY_MIME[normalizeType(mime)] ?? 'bin';
  if (!name) return `response.${extension}`;
  return urlExtension(path) ? name : `${name}.${extension}`;
}
