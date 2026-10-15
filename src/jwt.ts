// Compact JWS, RS256 only. No header field is ever taken from input: `alg` and `typ` are constants.

import { canonicalJson, type JsonObject } from './json.ts';

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlText(text: string): string {
  return base64url(new TextEncoder().encode(text));
}

const HEADER = base64urlText(canonicalJson({ alg: 'RS256', typ: 'JWT' }));

export async function signRs256(key: CryptoKey, claims: JsonObject, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const signingInput = `${HEADER}.${base64urlText(canonicalJson(claims))}`;
  const signature = await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
