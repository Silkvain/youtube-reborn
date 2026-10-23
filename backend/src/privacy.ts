/**
 * What may be published: minimum-contributor thresholds plus Laplace noise.
 *
 * Noise is deterministic per (aggregate, period): it's derived from a server secret and the
 * aggregate's key, so republishing the same aggregate every hour shows the same noisy value and
 * averaging many publications can't strip the noise. A new period gets fresh noise.
 */

export interface PrivacyParams {
  /** Published only when the noisy contributor count reaches this. */
  minContributors: number;
  /** Laplace noise scale is 1/epsilon (sensitivity 1: one person adds at most 1 per aggregate). */
  epsilon: number;
  /** Server secret mixed into the noise seed (Worker secret NOISE_SECRET). */
  secret: string;
}

async function uniformFrom(secret: string, label: string): Promise<number> {
  const data = new TextEncoder().encode(`${secret}|${label}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  // 52 random bits → a double in (0, 1).
  let x = 0;
  for (let i = 0; i < 7; i++) x = x * 256 + digest[i]!;
  return ((x % 2 ** 52) + 0.5) / 2 ** 52;
}

/** Laplace(0, scale) from a uniform in (0, 1). */
export function laplace(u: number, scale: number): number {
  const centred = u - 0.5;
  return -scale * Math.sign(centred) * Math.log(1 - 2 * Math.abs(centred));
}

/**
 * A noisy value for internal use (never published by itself, never thresholded), e.g. a channel's
 * popularity used to normalise its links. `sensitivity` is the most one person can change it by.
 */
export async function noisyValue(value: number, label: string, p: PrivacyParams, sensitivity: number): Promise<number> {
  return Math.max(0, value + laplace(await uniformFrom(p.secret, label), sensitivity / p.epsilon));
}

/** The noisy count to publish for `label`, or null if it falls below the threshold. */
export async function noisyCount(count: number, label: string, p: PrivacyParams): Promise<number | null> {
  const noisy = count + laplace(await uniformFrom(p.secret, label), 1 / p.epsilon);
  if (noisy < p.minContributors) return null;
  return Math.round(noisy);
}
