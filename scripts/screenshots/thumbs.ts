/**
 * Abstract placeholder thumbnails drawn in the page: a seeded gradient, soft shapes and a word,
 * so the screenshots look like a real feed without using anyone's real thumbnails.
 */
const PALETTES: [string, string, string][] = [
  ['#1d3557', '#457b9d', '#f1faee'],
  ['#6a040f', '#e85d04', '#ffba08'],
  ['#2d6a4f', '#95d5b2', '#081c15'],
  ['#3c096c', '#9d4edd', '#e0aaff'],
  ['#003049', '#f77f00', '#fcbf49'],
  ['#264653', '#2a9d8f', '#e9c46a'],
  ['#14213d', '#fca311', '#e5e5e5'],
  ['#5f0f40', '#fb8b24', '#e36414'],
];

function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 2 ** 32;
  };
}

export function drawThumb(videoId: string, word: string): string {
  const r = rng(videoId);
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d')!;
  const [a, b, ink] = PALETTES[Math.floor(r() * PALETTES.length)]!;
  const grad = g.createLinearGradient(0, 0, 640, 360);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, 640, 360);
  for (let i = 0; i < 5; i++) {
    g.globalAlpha = 0.12 + r() * 0.2;
    g.fillStyle = i % 2 ? ink : '#ffffff';
    g.beginPath();
    g.arc(r() * 640, r() * 360, 40 + r() * 160, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  g.font = '800 64px Poppins, Montserrat, "Arial Black", sans-serif';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,.45)';
  g.shadowBlur = 18;
  g.fillText(word.toUpperCase(), 36, 320);
  return c.toDataURL('image/png');
}
