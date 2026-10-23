/**
 * RSA blind signatures (Chaum) with a full-domain hash, used for anonymous upload tokens.
 *
 * The extension picks a random nonce, blinds its hash with a random factor r and asks the server
 * to sign the blinded value. The server never sees the nonce or the final signature, so when the
 * token is later spent the server can check it signed it, but not which issuance it came from.
 *
 * Plain BigInt arithmetic, because WebCrypto has no raw RSA operation. Runs in browsers and in
 * Cloudflare Workers. Keys are 2048-bit and rotate daily (see backend/src/keys.ts).
 */

export interface PublicKey {
  n: bigint;
  e: bigint;
}

export interface PrivateKey extends PublicKey {
  d: bigint;
  p: bigint;
  q: bigint;
  dp: bigint;
  dq: bigint;
  qi: bigint;
}

// ---- encoding ----

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

export function bigIntToBytes(x: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = x;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('value does not fit');
  return out;
}

export function byteLength(n: bigint): number {
  return Math.ceil(n.toString(16).length / 2);
}

function bitLength(n: bigint): number {
  return n.toString(2).length;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export const encodeInt = (x: bigint, n: bigint): string => toBase64Url(bigIntToBytes(x, byteLength(n)));
export const decodeInt = (s: string): bigint => bytesToBigInt(fromBase64Url(s));

// ---- arithmetic ----

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('not invertible');
  return ((oldS % m) + m) % m;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Uniform-enough random integer in [2, n) that is coprime to n. */
export function randomUnit(n: bigint): bigint {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength(n) + 16));
    const r = bytesToBigInt(bytes) % n;
    if (r > 1n && gcd(r, n) === 1n) return r;
  }
}

// ---- full-domain hash ----

/** MGF1 with SHA-384, expanded to the modulus size and reduced below n. */
export async function fullDomainHash(message: Uint8Array, n: bigint): Promise<bigint> {
  const len = byteLength(n);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let counter = 0; total < len; counter++) {
    const input = new Uint8Array(message.length + 4);
    input.set(message);
    new DataView(input.buffer).setUint32(message.length, counter);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', input));
    chunks.push(digest);
    total += digest.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  // Keep one bit fewer than n so the value is always below it.
  const x = bytesToBigInt(out.subarray(0, len));
  return x & ((1n << BigInt(bitLength(n) - 1)) - 1n);
}

// ---- protocol ----

/** Client: blind a message for signing. Keep `r` to unblind the reply. */
export async function blind(message: Uint8Array, key: PublicKey): Promise<{ blinded: bigint; r: bigint }> {
  const m = await fullDomainHash(message, key.n);
  const r = randomUnit(key.n);
  return { blinded: (m * modPow(r, key.e, key.n)) % key.n, r };
}

/** Server: sign a blinded value (RSA private operation, with CRT for speed). */
export function signBlinded(blinded: bigint, key: PrivateKey): bigint {
  if (blinded <= 1n || blinded >= key.n) throw new Error('blinded value out of range');
  const m1 = modPow(blinded % key.p, key.dp, key.p);
  const m2 = modPow(blinded % key.q, key.dq, key.q);
  const h = (key.qi * (((m1 - m2) % key.p) + key.p)) % key.p;
  return m2 + h * key.q;
}

/** Client: remove the blinding factor; throws if the server's signature is not valid. */
export async function finalize(message: Uint8Array, blindSig: bigint, r: bigint, key: PublicKey): Promise<bigint> {
  const sig = (blindSig * modInverse(r, key.n)) % key.n;
  if (!(await verify(message, sig, key))) throw new Error('server returned an invalid signature');
  return sig;
}

export async function verify(message: Uint8Array, sig: bigint, key: PublicKey): Promise<boolean> {
  if (sig <= 0n || sig >= key.n) return false;
  return modPow(sig, key.e, key.n) === (await fullDomainHash(message, key.n));
}

// ---- keys ----

export interface PrivateKeyJwk {
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
}

const b64uInt = (s: string) => bytesToBigInt(fromBase64Url(s));

export function privateKeyFromJwk(jwk: PrivateKeyJwk): PrivateKey {
  return {
    n: b64uInt(jwk.n),
    e: b64uInt(jwk.e),
    d: b64uInt(jwk.d),
    p: b64uInt(jwk.p),
    q: b64uInt(jwk.q),
    dp: b64uInt(jwk.dp),
    dq: b64uInt(jwk.dq),
    qi: b64uInt(jwk.qi),
  };
}

/** A fresh 2048-bit key from WebCrypto, exported so the raw operations above can use it. */
export async function generateKeyJwk(bits = 2048): Promise<PrivateKeyJwk> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const { n, e, d, p, q, dp, dq, qi } = jwk;
  if (!n || !e || !d || !p || !q || !dp || !dq || !qi) throw new Error('incomplete key export');
  return { n, e, d, p, q, dp, dq, qi };
}
