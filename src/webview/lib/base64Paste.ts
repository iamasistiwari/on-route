// Pasting a base64 blob into the URL bar: work out what it is and show it, instead of dropping a
// few thousand characters into the field.
import { detectMedia, type MediaInfo } from './media';

/** Enough of the blob to show in the URL bar, plus what was actually pasted. */
export interface PasteSource {
  /** Leading characters of the blob; the bar truncates further to fit. */
  head: string;
  /** Characters pasted, before decoding. */
  length: number;
}

export type DecodedPaste =
  | { ok: true; kind: 'media'; base64: string; bytes: number; media: MediaInfo; source: PasteSource }
  | { ok: true; kind: 'text'; text: string; bytes: number; source: PasteSource }
  | { ok: false; message: string; source: PasteSource };

/**
 * Below this, a base64-looking string is more likely an API key or an id than a file, and hijacking
 * the paste would be worse than pasting it. Anything with a media header clears it comfortably.
 */
const MIN_LENGTH = 256;

/** More than any address bar can show, and little enough to keep out of the DOM in bulk. */
const HEAD_LENGTH = 512;

const BASE64_RE = /^[A-Za-z0-9+/\-_]+={0,2}$/;
const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+)?;base64,(.*)$/s;

function toBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Readable text, as opposed to bytes that merely happen to decode: no control characters. */
function asText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/**
 * What a pasted string decodes to. `null` means it is not a base64 blob at all and should be pasted
 * as it is; a failed result means it looked like one but could not be turned into anything showable.
 */
export function decodeBase64Paste(text: string): DecodedPaste | null {
  // Copied out of JSON, a shell variable or a code editor, a blob usually arrives quoted. No base64
  // alphabet contains a quote, so stripping them is safe even when only one side has them.
  const trimmed = text.trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  if (!trimmed) return null;

  const dataUrl = DATA_URL_RE.exec(trimmed);
  const declaredType = dataUrl?.[1];
  // Base64 is commonly wrapped at a fixed column, so newlines are part of the payload, not a separator.
  const payload = (dataUrl ? dataUrl[2] : trimmed).replace(/\s+/g, '');

  if (!dataUrl && (payload.length < MIN_LENGTH || !BASE64_RE.test(payload))) return null;
  const source: PasteSource = { head: trimmed.slice(0, HEAD_LENGTH), length: trimmed.length };
  if (dataUrl && !payload) return { ok: false, message: 'Not valid base64', source };

  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = toBytes(base64);
  if (!bytes) return { ok: false, message: 'Not valid base64', source };

  const media = detectMedia(declaredType, undefined, base64);
  if (media.kind !== 'binary') return { ok: true, kind: 'media', base64, bytes: bytes.length, media, source };

  const asString = asText(bytes);
  if (asString !== null) return { ok: true, kind: 'text', text: asString, bytes: bytes.length, source };

  return { ok: false, message: 'Not a recognised format', source };
}
