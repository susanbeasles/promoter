// Bytes to JSON with a fatal UTF-8 decoder and a size bound. Shared by the request parser and the HTTP layer.

export type DecodeReason = 'too_large' | 'bad_encoding' | 'bad_json';

export class DecodeError extends Error {
  readonly reason: DecodeReason;
  constructor(reason: DecodeReason) {
    super(reason);
    this.name = 'DecodeError';
    this.reason = reason;
  }
}

export function decodeUtf8(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.byteLength > maxBytes) throw new DecodeError('too_large');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new DecodeError('bad_encoding');
  }
}

/** Bounded, fatal UTF-8, then JSON. An empty body is `bad_json`: callers that accept empty bodies check the length first. */
export function decodeJson(bytes: Uint8Array, maxBytes: number): unknown {
  const text = decodeUtf8(bytes, maxBytes);
  if (text.length === 0) throw new DecodeError('bad_json');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DecodeError('bad_json');
  }
}

export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
