import { createHash } from 'node:crypto';

// Official Note character set: https://docs.vestaboard.com/docs/charactercodes/
export const NOTE_ROWS = 3;
export const NOTE_COLUMNS = 15;
export const COLOR_CODES = { RED: 63, ORANGE: 64, YELLOW: 65, GREEN: 66, BLUE: 67, VIOLET: 68, WHITE: 69, BLACK: 70, FILLED: 71 };
const symbols = { '!': 37, '@': 38, '#': 39, '$': 40, '(': 41, ')': 42, '-': 44, '+': 46, '&': 47, '=': 48, ';': 49, ':': 50, "'": 52, '"': 53, '%': 54, ',': 55, '.': 56, '/': 59, '?': 60, '♥': 62 };
const chips = { '🟥': 'RED', '🟧': 'ORANGE', '🟨': 'YELLOW', '🟩': 'GREEN', '🟦': 'BLUE', '🟪': 'VIOLET', '⬜': 'WHITE', '⬛': 'BLACK' };
export const NOTE_CAPABILITIES = `Vestaboard Note has exactly 3 rows x 15 cells = 45 cells total. Each letter, space, punctuation mark, heart or color chip occupies ONE cell. Letter size is fixed. A-Z, 0-9 and ! @ # $ ( ) - + & = ; : ' " % , . / ? are supported. Accents become plain Latin letters. ♥ is the Note's built-in heart; the Note has NO degree symbol. Color chips are {RED}, {ORANGE}, {YELLOW}, {GREEN}, {BLUE}, {VIOLET}, {WHITE}, {BLACK}, and {FILLED}. Each token counts as ONE cell. Colors are whole solid tiles, never colored letters or text backgrounds. {FILLED} is the contrasting solid tile. No scrolling, custom glyphs, emoji faces or variable font sizes. Use color/heart only when requested or meaningful and never displace useful words to decorate.`;

export function normalizeNote(input) {
  return input.replace(/❤️?/gu, '♥').replace(/\uFE0F/gu, '')
    .normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'SS')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/°/g, ' DEG').replace(/\r\n?/g, '\n').toUpperCase();
}

export function noteCells(input) {
  const normalized = normalizeNote(input);
  const tokens = normalized.match(/\{[^{}]*\}|[^]/gu) || [];
  return tokens.map(token => {
    if (token === ' ') return 0;
    if (/^[A-Z]$/.test(token)) return token.charCodeAt(0) - 64;
    if (/^[1-9]$/.test(token)) return Number(token) + 26;
    if (token === '0') return 36;
    if (symbols[token] !== undefined) return symbols[token];
    const color = token.startsWith('{') ? token.slice(1, -1) : chips[token];
    if (COLOR_CODES[color] !== undefined) return COLOR_CODES[color];
    throw new Error('Unsupported Note character or color');
  });
}

export function fitNote(input) {
  const text = normalizeNote(input).trim();
  if (!text) throw new Error('Empty Note message');
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      if (noteCells(word).length > NOTE_COLUMNS) throw new Error('Word exceeds 15 cells');
      if (line && noteCells(line + ' ' + word).length > NOTE_COLUMNS) { lines.push(line); line = word; }
      else line += (line ? ' ' : '') + word;
    }
    lines.push(line);
  }
  if (lines.length > NOTE_ROWS) throw new Error('Message exceeds 3 rows');
  return lines.join('\n');
}

// Each new message ID chooses a palette/motif. A retry uses its saved layout.
const PALETTES = [
  [63, 64, 65], // sunset
  [67, 68, 69], // twilight
  [66, 67, 69], // sea glass
  [68, 63, 64], // berry
  [66, 65, 69], // citrus
  [67, 68, 63], // aurora
];

export function noteLayout(text, { decorate = false, seed = text } = {}) {
  const sourceLines = text.split('\n');
  if (!text.trim() || sourceLines.length > NOTE_ROWS) throw new Error('Invalid Note layout');
  // Empty padding from an AI response must not push the content off center.
  const lines = sourceLines.map(line => line.trim()).filter(Boolean);
  const result = Array.from({ length: NOTE_ROWS }, () => Array(NOTE_COLUMNS).fill(0));
  const protectedCells = Array.from({ length: NOTE_ROWS }, () => Array(NOTE_COLUMNS).fill(false));
  const rows = lines.length === 1 ? [1] : lines.length === 2 ? [0, 2] : [0, 1, 2];
  lines.forEach((line, index) => {
    const codes = noteCells(line);
    if (codes.length > NOTE_COLUMNS) throw new Error('Note row exceeds 15 cells');
    const row = rows[index], start = Math.floor((NOTE_COLUMNS - codes.length) / 2);
    result[row].splice(start, codes.length, ...codes);
    // Preserve all word spaces and one clear cell between text and decoration.
    for (let col = Math.max(0, start - 1); col < Math.min(NOTE_COLUMNS, start + codes.length + 1); col++) protectedCells[row][col] = true;
  });
  if (decorate) {
    const hash = createHash('sha256').update(String(seed)).digest();
    const palette = PALETTES[hash[0] % PALETTES.length];
    const motif = hash[1] % 3;
    const emptyRows = [0, 1, 2].filter(row => !rows.includes(row));
    const paintPair = (row, col, color) => {
      const other = NOTE_COLUMNS - 1 - col;
      // Whole pairs keep accents symmetric, including beside even-length text.
      if (protectedCells[row][col] || protectedCells[row][other]) return;
      if (result[row][col] !== 0 || result[row][other] !== 0) return;
      result[row][col] = color; result[row][other] = color;
    };
    for (const row of rows) {
      paintPair(row, 0, palette[0]);
      if (motif !== 2) paintPair(row, 1, palette[1]);
    }
    for (const row of emptyRows) {
      if (motif === 0) { // centered five-tile gradient
        for (let col = 5; col <= 7; col++) paintPair(row, col, palette[col - 5]);
      } else if (motif === 1) { // mirrored blocks with a center accent
        paintPair(row, 2, palette[0]); paintPair(row, 3, palette[1]); paintPair(row, 7, palette[2]);
      } else { // spaced, symmetric color rhythm
        paintPair(row, 1, palette[0]); paintPair(row, 4, palette[1]); paintPair(row, 7, palette[2]);
      }
    }
  }
  return result;
}

export function displayNote(text) {
  const emoji = Object.fromEntries(Object.entries(chips).map(([chip, color]) => [color, chip]));
  return text.replace(/\{([A-Z]+)\}/g, (_, name) => emoji[name] || (name === 'FILLED' ? '■' : `{${name}}`));
}

export function requestsPresentation(text) {
  return /\b(colou?r|red|orange|yellow|green|blue|violet|purple|white|black|heart|rainbow|farbe\w*|rot\w*|gr[uü]n\w*|blau\w*|gelb\w*|wei(?:ss|ß)\w*|schwarz\w*|herz\w*|regenbogen)\b/i.test(text);
}
