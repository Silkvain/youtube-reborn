/** The bytes a token signature covers: a fixed label, the day, and the client's random nonce. */
export function tokenMessage(epoch: string, nonce: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(`youtube-reborn-token|v1|${epoch}|`);
  const out = new Uint8Array(label.length + nonce.length);
  out.set(label);
  out.set(nonce, label.length);
  return out;
}
