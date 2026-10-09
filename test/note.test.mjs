import test from 'node:test';
import assert from 'node:assert/strict';
import { fitNote, noteCells, noteLayout, displayNote, normalizeNote } from '../lib/note.mjs';
import { validateFormat, prepareText, formatForBoard } from '../lib/format.mjs';

test('Note heart, color tiles and digits use official codes and count as one cell each', () => {
  assert.deepEqual(noteCells('A10 ♥❤️{RED}🟦{FILLED}'), [1,27,36,0,62,62,63,67,71]);
  assert.equal(normalizeNote('für Grüße 20°'), 'FUR GRUSSE 20 DEG');
  assert.equal(noteCells('{ORANGE}'.repeat(15)).length, 15);
  assert.equal(noteLayout('{ORANGE}'.repeat(15))[1].length, 15);
  assert.throws(() => noteLayout('{ORANGE}'.repeat(16)), /15/);
  assert.throws(() => noteCells('{PINK}')); assert.throws(() => noteCells('😀'));
  assert.equal(displayNote('{RED} LOVE ♥'), '🟥 LOVE ♥');
});

test('exact layouts center complete words and fill all 45 cells when requested', () => {
  assert.deepEqual(noteLayout('HELLO')[1], [0,0,0,0,0,8,5,12,12,15,0,0,0,0,0]);
  assert.deepEqual(noteLayout(('A'.repeat(15)+'\n').repeat(2)+'B'.repeat(15)), [Array(15).fill(1), Array(15).fill(1), Array(15).fill(2)]);
  assert.equal(fitNote('HELLO FROM WHATSAPP'), 'HELLO FROM\nWHATSAPP');
  assert.throws(() => fitNote('A'.repeat(16)), /Word/);
  assert.equal(prepareText('Show hello with a blue tile').needsFormatting, true);
  assert.equal(prepareText('♥ LOVE YOU {RED}').needsFormatting, false);
  assert.equal(validateFormat({ fits: true, lines: ['{RED} LOVE YOU ♥'] }, 'Love you'), '{RED} LOVE YOU ♥');
});

test('model receives full device limits, complete-word and three-row guidance, and returns exact codes', async () => {
  const result = await formatForBoard('bitte heute spülmaschine machen und müll rausbringen alex', { token: 'test', fetcher: async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    for (const text of ['3 rows x 15 cells', 'ALL THREE', '{RED}', 'NO degree symbol', 'whole solid tiles', 'never split I LOVE YOU']) assert.ok(system.includes(text));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fits: true, lines: ['ALEX: HEUTE', 'SPULMASCHINE &', 'MULL RAUSTRAGEN'] }) } }] }));
  } });
  assert.equal(result.text, 'ALEX: HEUTE\nSPULMASCHINE &\nMULL RAUSTRAGEN');
  assert.deepEqual(result.characters, noteLayout(result.text));
});

test('spoken display instructions may turn number words into numerals and tile counts', () => {
  const result = validateFormat({ fits: true, lines: ['DINNER AT 7', '{GREEN} {GREEN}'] }, 'Put dinner at seven on the board with two green tiles', { spoken: true });
  assert.equal(result, 'DINNER AT 7\n{GREEN} {GREEN}');
  assert.throws(() => validateFormat({ fits: true, lines: ['A'.repeat(16)] }, 'Say this', { spoken: true }), /maximum is 15/);
});

test('one, two and three lines are vertically symmetric, even with empty AI padding', () => {
  const activeRows = grid => grid.flatMap((row, index) => row.some(Boolean) ? [index] : []);
  assert.deepEqual(activeRows(noteLayout('HELLO')), [1]);
  assert.deepEqual(activeRows(noteLayout('ALEX,\nI LOVE YOU ♥')), [0, 2]);
  assert.deepEqual(activeRows(noteLayout('ONE\nTWO\nTHREE')), [0, 1, 2]);
  assert.deepEqual(noteLayout('\n HELLO \n'), noteLayout('HELLO'));
  assert.deepEqual(noteLayout('   ALEX,  \n I LOVE YOU ♥  '), noteLayout('ALEX,\nI LOVE YOU ♥'));
});

test('coordinated decorations preserve every glyph, word space and clear text margin', () => {
  for (const text of ['HELLO', 'ALEX,\nI LOVE YOU ♥', 'TAKE BINS OUT\nTOMORROW\nMORNING', '♥ LOVE {RED}']) {
    const base = noteLayout(text);
    for (let seed = 0; seed < 30; seed++) {
      const decorated = noteLayout(text, { decorate: true, seed });
      assert.equal(decorated.length, 3); assert.ok(decorated.every(row => row.length === 15));
      assert.ok(decorated.flat().some(code => code >= 63 && code <= 69));
      base.forEach((row, r) => {
        const occupied = row.flatMap((code, c) => code ? [c] : []);
        const from = occupied.length ? Math.max(0, occupied[0] - 1) : 15;
        const to = occupied.length ? Math.min(14, occupied.at(-1) + 1) : -1;
        for (let c = 0; c < 15; c++) {
          if (c >= from && c <= to) assert.equal(decorated[r][c], row[c]);
          else if (decorated[r][c]) {
            assert.ok(decorated[r][c] >= 63 && decorated[r][c] <= 69);
            assert.equal(decorated[r][c], decorated[r][14 - c]);
          }
        }
      });
    }
  }
});

test('message seeds vary motifs and palettes, retries are stable, and full boards keep every cell', () => {
  const full = ['A'.repeat(15), 'B'.repeat(15), 'C'.repeat(15)].join('\n');
  assert.deepEqual(noteLayout(full, { decorate: true, seed: 'a' }), noteLayout(full));
  const text = 'HELLO';
  assert.deepEqual(noteLayout(text, { decorate: true, seed: 'same' }), noteLayout(text, { decorate: true, seed: 'same' }));
  const designs = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(noteLayout(text, { decorate: true, seed: `message-${i}` }))));
  assert.ok(designs.size >= 10);
});
