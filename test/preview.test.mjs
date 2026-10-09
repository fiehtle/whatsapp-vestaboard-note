import test from 'node:test';
import assert from 'node:assert/strict';
import { noteGlyph, noteCells } from '../lib/note.mjs';
import { deliveryPreview } from '../lib/feedback.mjs';
import { renderNoteSvg, renderNotePng, PREVIEW_WIDTH, PREVIEW_HEIGHT } from '../lib/preview.mjs';

test('image preview keeps all 45 cells at fixed coordinates including the far-right tiles', () => {
  const layout = [
    [63,64,65,66,67,68,69,70,71,0,0,0,0,0,0],
    [0,0,8,5,12,12,15,0,62,0,0,0,0,0,0],
    [1,26,27,28,29,30,31,32,33,34,35,36,37,60,55],
  ];
  const original = structuredClone(layout);
  const svg = renderNoteSvg(layout);
  const cells = [...svg.matchAll(/transform="translate\((\d+) (\d+)\)" data-row="(\d+)" data-column="(\d+)" data-code="(\d+)"/g)];
  assert.equal(cells.length, 45);
  for (const [, x, y, row, column, code] of cells) {
    assert.equal(Number(code), layout[row][column]);
    assert.ok(Number(x) + 68 <= PREVIEW_WIDTH);
    assert.ok(Number(y) + 112 <= PREVIEW_HEIGHT);
  }
  assert.deepEqual(cells.filter(c => c[4] === '14').map(c => Number(c[1])), [1110, 1110, 1110]);
  assert.deepEqual(layout, original);
});

test('supported characters and colors round-trip and XML punctuation stays literal', () => {
  const characters = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$()-+&=;:\'"%,./?♥';
  assert.equal(noteCells(characters).map(noteGlyph).join(''), characters);
  for (let code = 63; code <= 71; code++) assert.equal(noteGlyph(code), '');
  const svg = renderNoteSvg([noteCells('&'.padEnd(15)), Array(15).fill(0), Array(15).fill(0)]);
  assert.match(svg, />&amp;<\/text>/);
});

test('receipt previews the saved final device array, never regenerating text or decoration', () => {
  const first = Array.from({ length: 3 }, () => Array(15).fill(63));
  const final = Array.from({ length: 3 }, () => Array(15).fill(67));
  const reply = deliveryPreview({ pages: ['DIFFERENT', 'TEXT'], layouts: [first, final] });
  assert.deepEqual(reply, { type: 'image', layout: final });
});

test('PNG output includes bundled font glyphs and fits WhatsApp as one fixed-size image', () => {
  const blank = Array.from({ length: 3 }, () => Array(15).fill(0));
  const text = structuredClone(blank); text[1] = noteCells('A & ♥'.padEnd(15));
  const png = renderNotePng(text);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), PREVIEW_WIDTH);
  assert.equal(png.readUInt32BE(20), PREVIEW_HEIGHT);
  assert.ok(png.length < 5 * 1024 * 1024);
  assert.ok(!png.equals(renderNotePng(blank)));
  assert.ok(png.equals(renderNotePng(text)));
});

test('invalid device arrays are rejected rather than presenting an inaccurate preview', () => {
  for (const layout of [null, [], [Array(15).fill(0)], Array(3).fill(Array(14).fill(0)),
    Array(3).fill(Array(15).fill(999)), Array(3).fill(Array(15).fill('1'))]) {
    assert.throws(() => renderNoteSvg(layout), /Invalid Note preview/);
  }
});
