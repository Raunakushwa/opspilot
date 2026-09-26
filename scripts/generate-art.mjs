/**
 * Generates the landing page artwork as SVG.
 *
 * The art is produced by code rather than drawn or downloaded: it is
 * deterministic (same seed, same output), weighs a few KB, needs no external
 * request, and can be regenerated after a palette change. The visual language
 * blends a 1-bit halftone dither with soft pastel gradients.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'art');

const PALETTE = {
  ink: '#0d0d12',
  paper: '#fefefe',
  peach: '#f0cdc2',
  lilac: '#c9b3f5',
  blue: '#88aaf1',
  mint: '#b8faf6',
  pink: '#f386a1',
  magenta: '#d45bb6',
};

/** Deterministic PRNG, so regenerating never produces a different picture. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

/** Smooth value noise: cheap, and good enough for cloud shapes. */
function noise2(x, y, seed = 1) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 43.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const ease = (t) => t * t * (3 - 2 * t);
  const tl = noise2(xi, yi, seed);
  const tr = noise2(xi + 1, yi, seed);
  const bl = noise2(xi, yi + 1, seed);
  const br = noise2(xi + 1, yi + 1, seed);
  const top = tl + (tr - tl) * ease(xf);
  const bottom = bl + (br - bl) * ease(xf);
  return top + (bottom - top) * ease(yf);
}

/**
 * Halftone dither: a grid of dots whose radius follows a density function.
 * This is the texture that makes the artwork read as printed rather than
 * rendered, and it is the one element both reference aesthetics share.
 */
function halftone({ width, height, step, density, colour, opacity = 1 }) {
  const dots = [];
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      const value = density(x / width, y / height);
      // Skipping faint dots is what keeps the file small: most of the grid
      // contributes nothing visible.
      if (value <= 0.12) continue;
      const radius = Math.min(step * 0.52, value * step * 0.58);
      if (radius < 0.25) continue;
      dots.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${radius.toFixed(1)}"/>`);
    }
  }
  return `<g fill="${colour}" opacity="${opacity}">${dots.join('')}</g>`;
}

function svg(width, height, body, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none" role="img" aria-hidden="true">${extra}${body}</svg>\n`;
}

// ---------------------------------------------------------------------------
// Hero: a dark sky with drifting dithered cloud banks, a rising signal line
// and floating panels — an incident seen from above.
// ---------------------------------------------------------------------------
function hero() {
  const W = 1600;
  const H = 900;
  const random = rng(20260926);

  const defs = `<defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#14121f"/>
      <stop offset="0.45" stop-color="#1b1630"/>
      <stop offset="1" stop-color="#0d0d12"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.26" cy="0.32" r="0.42">
      <stop offset="0" stop-color="${PALETTE.lilac}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${PALETTE.lilac}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.74" cy="0.6" r="0.4">
      <stop offset="0" stop-color="${PALETTE.pink}" stop-opacity="0.42"/>
      <stop offset="1" stop-color="${PALETTE.pink}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowC" cx="0.56" cy="0.18" r="0.3">
      <stop offset="0" stop-color="${PALETTE.mint}" stop-opacity="0.3"/>
      <stop offset="1" stop-color="${PALETTE.mint}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="signal" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${PALETTE.mint}"/>
      <stop offset="0.55" stop-color="${PALETTE.blue}"/>
      <stop offset="1" stop-color="${PALETTE.pink}"/>
    </linearGradient>
  </defs>`;

  const layers = [
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>`,
    `<rect width="${W}" height="${H}" fill="url(#glowA)"/>`,
    `<rect width="${W}" height="${H}" fill="url(#glowB)"/>`,
    `<rect width="${W}" height="${H}" fill="url(#glowC)"/>`,
  ];

  // Two cloud banks of different grain, like a two-colour print.
  layers.push(
    halftone({
      width: W,
      height: H,
      step: 15,
      colour: PALETTE.lilac,
      opacity: 0.55,
      density: (u, v) => {
        const n = smoothNoise(u * 7, v * 4 + 1.5, 3);
        const falloff = Math.max(0, 1 - Math.hypot((u - 0.28) * 1.5, (v - 0.35) * 2.1));
        return Math.max(0, n * falloff * 1.7 - 0.2);
      },
    }),
  );
  layers.push(
    halftone({
      width: W,
      height: H,
      step: 13,
      colour: PALETTE.pink,
      opacity: 0.5,
      density: (u, v) => {
        const n = smoothNoise(u * 9 + 3, v * 5, 11);
        const falloff = Math.max(0, 1 - Math.hypot((u - 0.78) * 1.7, (v - 0.62) * 2.3));
        return Math.max(0, n * falloff * 1.6 - 0.18);
      },
    }),
  );

  // A faint measurement grid: this is an operations tool, not a poster.
  const grid = [];
  for (let x = 0; x <= W; x += 64) {
    grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
  }
  for (let y = 0; y <= H; y += 64) {
    grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
  }
  layers.push(
    `<g stroke="${PALETTE.paper}" stroke-width="0.5" opacity="0.045">${grid.join('')}</g>`,
  );

  // The error-rate curve: flat, then a deploy marker, then the climb.
  const points = [];
  for (let i = 0; i <= 120; i += 1) {
    const t = i / 120;
    const x = 120 + t * (W - 260);
    const base = H * 0.72;
    const spike = t < 0.52 ? 0 : Math.pow((t - 0.52) / 0.48, 1.7) * 250;
    const jitter = (random() - 0.5) * (t < 0.52 ? 6 : 16);
    points.push(`${x.toFixed(1)},${(base - spike + jitter).toFixed(1)}`);
  }
  layers.push(
    `<polyline points="${points.join(' ')}" stroke="url(#signal)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>`,
  );

  // The deploy marker, where the curve turns.
  const deployX = 120 + 0.52 * (W - 260);
  layers.push(`<g opacity="0.9">
    <line x1="${deployX}" y1="${H * 0.28}" x2="${deployX}" y2="${H * 0.8}" stroke="${PALETTE.paper}" stroke-width="1" stroke-dasharray="4 6" opacity="0.5"/>
    <circle cx="${deployX}" cy="${H * 0.72}" r="7" fill="${PALETTE.ink}" stroke="${PALETTE.mint}" stroke-width="2"/>
  </g>`);

  // Floating panels, drawn flat and hard-edged, the way the product looks.
  const panel = (x, y, w, h, tone, rows) => {
    const lines = Array.from({ length: rows }, (_, i) => {
      const lw = w - 28 - random() * (w * 0.32);
      return `<rect x="${x + 14}" y="${y + 34 + i * 13}" width="${lw.toFixed(0)}" height="4" fill="${PALETTE.paper}" opacity="${0.18 + i * 0.05}"/>`;
    }).join('');
    return `<g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${PALETTE.ink}" fill-opacity="0.82" stroke="${PALETTE.paper}" stroke-opacity="0.22"/>
      <rect x="${x}" y="${y}" width="${w}" height="20" fill="${tone}" fill-opacity="0.9"/>
      <circle cx="${x + 11}" cy="${y + 10}" r="3" fill="${PALETTE.ink}" fill-opacity="0.7"/>
      ${lines}
    </g>`;
  };

  layers.push(panel(150, 150, 250, 130, PALETTE.mint, 5));
  layers.push(panel(430, 96, 210, 104, PALETTE.lilac, 4));
  layers.push(panel(1080, 210, 280, 150, PALETTE.pink, 6));
  layers.push(panel(1270, 96, 190, 96, PALETTE.peach, 3));

  // Corner crop marks.
  const mark = (x, y, sx, sy) =>
    `<path d="M${x} ${y + sy * 26} L${x} ${y} L${x + sx * 26} ${y}" stroke="${PALETTE.paper}" stroke-opacity="0.35" stroke-width="1.5"/>`;
  layers.push(
    `<g>${mark(44, 44, 1, 1)}${mark(W - 44, 44, -1, 1)}${mark(44, H - 44, 1, -1)}${mark(W - 44, H - 44, -1, -1)}</g>`,
  );

  return svg(W, H, layers.join(''), defs);
}

// ---------------------------------------------------------------------------
// Ledger: evidence ids connecting to an answer, with one rejected.
// ---------------------------------------------------------------------------
function ledger() {
  const W = 720;
  const H = 460;
  const defs = `<defs>
    <linearGradient id="keep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${PALETTE.mint}"/>
      <stop offset="1" stop-color="${PALETTE.blue}"/>
    </linearGradient>
  </defs>`;
  const sources = [
    { label: 'deployments', y: 70, ok: true },
    { label: 'logs', y: 145, ok: true },
    { label: 'metrics', y: 220, ok: true },
    { label: 'runbook', y: 295, ok: true },
    { label: 'invented', y: 370, ok: false },
  ];

  const body = sources
    .map((source) => {
      const colour = source.ok ? 'url(#keep)' : PALETTE.pink;
      const line = source.ok
        ? `<path d="M232 ${source.y} C 330 ${source.y}, 380 230, 470 230" stroke="url(#keep)" stroke-width="2" opacity="0.8"/>`
        : `<path d="M232 ${source.y} C 300 ${source.y}, 330 320, 360 330" stroke="${PALETTE.pink}" stroke-width="2" stroke-dasharray="5 5" opacity="0.85"/>
           <g transform="translate(372 322)" stroke="${PALETTE.pink}" stroke-width="2.5" stroke-linecap="round">
             <line x1="-9" y1="-9" x2="9" y2="9"/><line x1="9" y1="-9" x2="-9" y2="9"/>
           </g>`;
      return `<g>
        <rect x="40" y="${source.y - 21}" width="192" height="42" fill="${PALETTE.ink}" fill-opacity="0.9" stroke="${colour}" stroke-opacity="0.85"/>
        <text x="56" y="${source.y + 5}" font-family="ui-monospace, monospace" font-size="13" fill="${PALETTE.paper}" fill-opacity="${source.ok ? 0.92 : 0.5}">${source.label}</text>
        ${line}
      </g>`;
    })
    .join('');

  const answer = `<g>
    <rect x="470" y="170" width="210" height="120" fill="${PALETTE.ink}" fill-opacity="0.95" stroke="${PALETTE.paper}" stroke-opacity="0.3"/>
    <rect x="470" y="170" width="210" height="22" fill="${PALETTE.lilac}" fill-opacity="0.92"/>
    <text x="482" y="186" font-family="ui-monospace, monospace" font-size="11" fill="${PALETTE.ink}">ANSWER</text>
    ${[0, 1, 2, 3]
      .map(
        (i) =>
          `<rect x="486" y="${208 + i * 16}" width="${170 - i * 22}" height="5" fill="${PALETTE.paper}" opacity="${0.5 - i * 0.08}"/>`,
      )
      .join('')}
  </g>`;

  return svg(W, H, `<rect width="${W}" height="${H}" fill="none"/>${body}${answer}`, defs);
}

// ---------------------------------------------------------------------------
// Gate: the agent proposes, a person decides, the action executes.
// ---------------------------------------------------------------------------
function gate() {
  const W = 760;
  const H = 260;
  const defs = `<defs>
    <linearGradient id="flow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${PALETTE.lilac}"/>
      <stop offset="1" stop-color="${PALETTE.mint}"/>
    </linearGradient>
  </defs>`;

  const node = (x, w, label, tone) => `<g>
    <rect x="${x}" y="98" width="${w}" height="64" fill="${PALETTE.ink}" fill-opacity="0.92" stroke="${tone}" stroke-opacity="0.9"/>
    <text x="${x + w / 2}" y="135" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="${PALETTE.paper}" fill-opacity="0.92">${label}</text>
  </g>`;

  // Solid, not a gradient: a horizontal line has a zero-height bounding box,
  // and objectBoundingBox gradients degenerate to nothing on one.
  const arrow = (x, len) =>
    `<g stroke="${PALETTE.blue}" stroke-width="2" fill="none" opacity="0.9"><line x1="${x}" y1="130" x2="${x + len}" y2="130"/><path d="M${x + len - 7} 124 L${x + len} 130 L${x + len - 7} 136"/></g>`;

  // The dashed line is the point of the picture: nothing crosses it without a
  // person, so it is drawn taller than everything else.
  const barrier = `<g>
    <line x1="330" y1="24" x2="330" y2="236" stroke="${PALETTE.pink}" stroke-width="2" stroke-dasharray="6 7" opacity="0.9"/>
    <rect x="262" y="34" width="136" height="26" fill="${PALETTE.pink}"/>
    <text x="330" y="52" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="${PALETTE.ink}">HUMAN DECIDES</text>
  </g>`;

  return svg(
    W,
    H,
    [
      node(20, 190, 'agent proposes', PALETTE.lilac),
      arrow(222, 84),
      barrier,
      node(360, 180, 'api executes', PALETTE.mint),
      arrow(552, 60),
      node(622, 120, 'audit log', PALETTE.sky ?? PALETTE.blue),
    ].join(''),
    defs,
  );
}

// ---------------------------------------------------------------------------
// A tiling dither, used as a texture over flat sections.
// ---------------------------------------------------------------------------
function texture() {
  const S = 120;
  return svg(
    S,
    S,
    halftone({
      width: S,
      height: S,
      step: 7,
      colour: PALETTE.ink,
      opacity: 0.5,
      density: (u, v) => Math.max(0, smoothNoise(u * 4, v * 4, 7) * 0.9 - 0.25),
    }),
  );
}

mkdirSync(OUT, { recursive: true });
const artwork = {
  'hero.svg': hero(),
  'ledger.svg': ledger(),
  'gate.svg': gate(),
  'texture.svg': texture(),
};
for (const [name, content] of Object.entries(artwork)) {
  writeFileSync(join(OUT, name), content);
  // eslint-disable-next-line no-console -- a build script reporting its output
  console.log(`${name}  ${(content.length / 1024).toFixed(1)} KB`);
}
