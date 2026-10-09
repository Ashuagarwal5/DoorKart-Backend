import sharp from 'sharp';

import type { DemoCategory } from './demo-catalog-data.js';

/**
 * Makes simple placeholder pictures for demo products: a soft coloured card, a flat icon for the
 * kind of product, and its name. They stand in until real photos are uploaded in the admin panel.
 */

const SIZE = 1200;
const NAVY = '#0f1b33';

type Theme = { background: string; circle: string; icon: string };

/** Three looks per category, so a product with several pictures does not repeat one card. */
const THEMES: Record<DemoCategory, Theme[]> = {
  stationery: [
    { background: '#e6f0fd', circle: '#c7dcfa', icon: '#0b57c9' },
    { background: '#fff3e6', circle: '#fde0c2', icon: '#ea580c' },
    { background: '#eef2f7', circle: '#d9e1ec', icon: '#0f1b33' },
  ],
  'gift-items': [
    { background: '#fff1e6', circle: '#fddcc0', icon: '#ea580c' },
    { background: '#fdeaf1', circle: '#f9cfdf', icon: '#be185d' },
    { background: '#e6f0fd', circle: '#c7dcfa', icon: '#0b57c9' },
  ],
  toys: [
    { background: '#fff8da', circle: '#fdeea3', icon: '#d97706' },
    { background: '#e6f0fd', circle: '#c7dcfa', icon: '#0b57c9' },
    { background: '#e8f8ec', circle: '#c6edd0', icon: '#15803d' },
  ],
  'sports-items': [
    { background: '#e6f6ec', circle: '#c5e8d2', icon: '#15803d' },
    { background: '#e6f0fd', circle: '#c7dcfa', icon: '#0b57c9' },
    { background: '#fff1e6', circle: '#fddcc0', icon: '#ea580c' },
  ],
  'decoration-items': [
    { background: '#f0eafd', circle: '#ddd0fa', icon: '#6d28d9' },
    { background: '#fff3e6', circle: '#fde0c2', icon: '#ea580c' },
    { background: '#e6f0fd', circle: '#c7dcfa', icon: '#0b57c9' },
  ],
};

/** Flat icons drawn on a 100 x 100 grid, centred. Each uses `currentColor` for the main shape. */
const ICONS: Record<DemoCategory, string> = {
  stationery:
    '<g transform="rotate(-35 50 50)"><rect x="40" y="10" width="20" height="62" rx="3" fill="currentColor"/><rect x="40" y="10" width="20" height="10" rx="3" fill="#ffffff" fill-opacity="0.45"/><path d="M40 72 L60 72 L50 92 Z" fill="currentColor" fill-opacity="0.75"/></g>',
  'gift-items':
    '<rect x="18" y="42" width="64" height="44" rx="4" fill="currentColor"/><rect x="14" y="32" width="72" height="14" rx="4" fill="currentColor" fill-opacity="0.8"/><rect x="45" y="32" width="10" height="54" fill="#ffffff" fill-opacity="0.55"/><path d="M50 32 C38 14 20 22 32 32 Z" fill="currentColor"/><path d="M50 32 C62 14 80 22 68 32 Z" fill="currentColor"/>',
  toys:
    '<rect x="14" y="58" width="34" height="28" rx="4" fill="currentColor"/><rect x="52" y="58" width="34" height="28" rx="4" fill="currentColor" fill-opacity="0.75"/><rect x="33" y="28" width="34" height="28" rx="4" fill="currentColor" fill-opacity="0.9"/><circle cx="24" cy="58" r="3.5" fill="#ffffff" fill-opacity="0.6"/><circle cx="62" cy="58" r="3.5" fill="#ffffff" fill-opacity="0.6"/><circle cx="43" cy="28" r="3.5" fill="#ffffff" fill-opacity="0.6"/><circle cx="57" cy="28" r="3.5" fill="#ffffff" fill-opacity="0.6"/>',
  'sports-items':
    '<circle cx="50" cy="50" r="38" fill="currentColor"/><path d="M12 50 C32 38 68 38 88 50" stroke="#ffffff" stroke-opacity="0.7" stroke-width="3.5" fill="none"/><path d="M12 50 C32 62 68 62 88 50" stroke="#ffffff" stroke-opacity="0.7" stroke-width="3.5" fill="none"/><path d="M50 12 C40 30 40 70 50 88" stroke="#ffffff" stroke-opacity="0.7" stroke-width="3.5" fill="none"/>',
  'decoration-items':
    '<path d="M36 90 C28 70 30 55 40 48 L40 40 L60 40 L60 48 C70 55 72 70 64 90 Z" fill="currentColor"/><rect x="38" y="34" width="24" height="8" rx="3" fill="currentColor" fill-opacity="0.8"/><path d="M50 34 C46 20 38 14 30 18 C34 26 40 32 50 34 Z" fill="currentColor" fill-opacity="0.7"/><path d="M50 34 C54 18 64 12 72 16 C68 26 60 32 50 34 Z" fill="currentColor" fill-opacity="0.85"/>',
};

const escapeXml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Splits a name into at most three short lines for the card. */
function wrap(name: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of name.split(' ')) {
    if (line && `${line} ${word}`.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.slice(0, 3);
}

/** One picture as JPEG bytes. `index` (0, 1, 2) picks the look. */
export async function makeDemoPicture(category: DemoCategory, name: string, index: number): Promise<Buffer> {
  const theme = THEMES[category][index % 3] ?? THEMES[category][0]!;
  const lines = wrap(name, 22);
  const fontSize = 64;
  const textTop = 900 - ((lines.length - 1) * (fontSize + 12)) / 2;

  const text = lines
    .map(
      (line, row) =>
        `<text x="${SIZE / 2}" y="${textTop + row * (fontSize + 12)}" font-size="${fontSize}" font-weight="700" text-anchor="middle" fill="${NAVY}" font-family="Arial, Helvetica, sans-serif">${escapeXml(line)}</text>`
    )
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
    <rect width="${SIZE}" height="${SIZE}" fill="${theme.background}"/>
    <circle cx="${index === 1 ? 640 : 600}" cy="${index === 2 ? 440 : 400}" r="${index === 1 ? 330 : 300}" fill="${theme.circle}"/>
    <g transform="translate(${index === 1 ? 640 : 600} ${index === 2 ? 440 : 400}) scale(${index === 2 ? 4.2 : 3.4}) translate(-50 -50)" color="${theme.icon}">${ICONS[category]}</g>
    ${text}
    <text x="${SIZE / 2}" y="1130" font-size="30" text-anchor="middle" fill="${NAVY}" fill-opacity="0.45" font-family="Arial, Helvetica, sans-serif">DoorKart</text>
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}
