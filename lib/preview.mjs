import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { NOTE_ROWS, NOTE_COLUMNS, noteGlyph } from './note.mjs';

export const PREVIEW_WIDTH = 1196;
export const PREVIEW_HEIGHT = 400;
// Approximate physical tile colors, independent of the phone's emoji artwork.
const colors = { 63: '#db4437', 64: '#ed8235', 65: '#f0ce48', 66: '#3e9d66', 67: '#107db8', 68: '#8f4199', 69: '#ededeb', 70: '#08090a', 71: '#ededeb' };
const fontFile = fileURLToPath(new URL('../assets/fonts/IBMPlexMono-Light.ttf', import.meta.url));
const escape = value => value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export function renderNoteSvg(layout) {
  if (!Array.isArray(layout) || layout.length !== NOTE_ROWS ||
      layout.some(row => !Array.isArray(row) || row.length !== NOTE_COLUMNS)) throw new Error('Invalid Note preview layout');
  const cells = layout.flatMap((row, r) => row.map((code, c) => {
    const glyph = noteGlyph(code);
    const content = colors[code]
      ? `<rect x="3" y="22" width="62" height="68" fill="${colors[code]}"/>`
      : code === 62
        ? '<path d="M34 79C29 73 9 61 9 46C9 28 29 26 34 41C39 26 59 28 59 46C59 61 39 73 34 79Z" fill="#e5e5e3"/>'
        : code === 9
          ? '<path d="M34 30V80" stroke="#e5e5e3" stroke-width="2.5"/>'
        : `<text x="34" y="80" text-anchor="middle" font-family="IBM Plex Mono" font-weight="300" font-size="70" fill="#e5e5e3">${escape(glyph)}</text>`;
    return `<g transform="translate(${18 + c * 78} ${18 + r * 126})" data-row="${r}" data-column="${c}" data-code="${code}">
      <rect width="68" height="112" rx="2" fill="#08090a"/>
      <rect x="3" y="3" width="62" height="106" rx="1" fill="#242628"/>
      ${content}
      <path d="M3 56H65" stroke="#08090a" stroke-width="1.5"/>
      <path d="M5 5H63" stroke="#36383a" stroke-width="1"/>
    </g>`;
  })).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}">
    <rect width="100%" height="100%" rx="6" fill="#333536"/>${cells}</svg>`;
}

export function renderNotePng(layout) {
  return new Resvg(renderNoteSvg(layout), {
    font: { fontFiles: [fontFile], loadSystemFonts: false },
  }).render().asPng();
}
