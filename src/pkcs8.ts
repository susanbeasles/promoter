// The App private key arrives from Secrets Store as an unencrypted PKCS#8 PEM and leaves this module as a
// non-extractable WebCrypto key. Nothing here ever includes key material in an error.

export const PEM_LIMITS = Object.freeze({ maxChars: 16_384 });

export type KeyProblem = 'too_large' | 'pkcs1_not_pkcs8' | 'encrypted' | 'not_pkcs8_pem' | 'bad_base64' | 'import_failed';

export class KeyError extends Error {
  readonly problem: KeyProblem;
  constructor(problem: KeyProblem) {
    super(problem);
    this.name = 'KeyError';
    this.problem = problem;
  }
}

const BEGIN = '-----BEGIN PRIVATE KEY-----';
const END = '-----END PRIVATE KEY-----';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const RSA_SIGN_ALGORITHM = Object.freeze({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' });

/** PEM text to DER bytes. Refuses PKCS#1 (`BEGIN RSA PRIVATE KEY`, GitHub's download format) with a distinct problem. */
export function decodePkcs8Pem(pem: string): Uint8Array {
  if (pem.length > PEM_LIMITS.maxChars) throw new KeyError('too_large');
  const lines = pem
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === '-----BEGIN RSA PRIVATE KEY-----') throw new KeyError('pkcs1_not_pkcs8');
  if (first === '-----BEGIN ENCRYPTED PRIVATE KEY-----') throw new KeyError('encrypted');
  if (lines.length < 3 || first !== BEGIN || last !== END) throw new KeyError('not_pkcs8_pem');
  const base64 = lines.slice(1, -1).join('');
  if (!BASE64.test(base64) || base64.length % 4 !== 0) throw new KeyError('bad_base64');
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new KeyError('bad_base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function importPkcs8Pem(pem: string, subtle: SubtleCrypto = crypto.subtle): Promise<CryptoKey> {
  const der = decodePkcs8Pem(pem);
  try {
    return await subtle.importKey('pkcs8', new Uint8Array(der), RSA_SIGN_ALGORITHM, false, ['sign']);
  } catch {
    throw new KeyError('import_failed');
  }
}
