// Explicit, billable live evaluation; never runs inside the deployed service.
import { writeFile } from 'node:fs/promises';
import { prepareText, formatForBoard } from '../lib/format.mjs';
import { noteCells, noteLayout } from '../lib/note.mjs';

const cases = [
  { name: 'short text stays exact', input: 'hello from whatsapp', exact: 'HELLO FROM\nWHATSAPP', checks: [] },
  { name: 'German chores use three rows', input: 'bitte heute spülmaschine machen und müll rausbringen alex', rows: 3, minCells: 35, checks: [/ALEX/, /HEUTE/, /SPULMASCHINE/, /MULL/, /RAUS/] },
  { name: 'recycling timing', input: 'Please remember to take the recycling bins out tomorrow morning.', rows: 3, checks: [/RECYCL/, /TOMORROW/, /MORNING/] },
  { name: 'German names and two chores', input: 'Anna, bitte heute die Waschmaschine starten und die Blumen giessen', rows: 3, checks: [/ANNA/, /HEUTE/, /WASCH|WASCHE/, /BLUMEN/] },
  { name: 'negative feeding instruction', input: 'Please do not feed the dog before 19:30 tonight, thank you.', checks: [/NO|NOT|NEVER/, /DOG/, /19:30/, /TONIGHT/] },
  { name: 'German negative feeding instruction', input: 'Bitte den Hund heute nicht vor 19:30 füttern, danke', checks: [/NICHT|KEIN/, /HUND/, /19:30/, /HEUTE/] },
  { name: 'reminder is not a prohibition', input: "Don't forget to take the recycling bins out tomorrow morning.", checks: [/RECYCL/, /TOMORROW/, /MORNING/], excludes: /NO BINS|NOT OUT|DONT TAKE/ },
  { name: 'name and morning timing', input: 'Laura, please water the plants before leaving tomorrow morning.', checks: [/LAURA/, /PLANTS/, /TOMORROW/, /MORNING/] },
  { name: 'spoken phrase grouping', spoken: true, input: 'Alex, I love you.', checks: [/ALEX/, /I LOVE YOU/], sameLine: 'I LOVE YOU' },
  { name: 'spoken number and two tiles', spoken: true, input: 'Put dinner at seven on the board with two green tiles.', checks: [/DINNER/, /7/], color: 66, colorCount: 2 },
  { name: 'red tile and heart', spoken: true, input: 'Please put love you on the board with a red tile and a heart.', checks: [/LOVE YOU/, /♥/], color: 63 },
  { name: 'unsupported emoji interpreted', input: '🌧️ Please remember to take your umbrella when you leave home tomorrow morning.', checks: [/UMBRELLA/, /TOMORROW/, /MORNING/] },
  { name: 'numeric overload summarizes main request', input: 'Dinner at 19:30. Secondary timetable: 12:00, 14:00, 16:00, 18:15, 22:45, 23:10.', checks: [/DINNER/, /19:30/] },
];

const results = [];
for (const item of cases) {
  const start = Date.now();
  try {
    const prepared = prepareText(item.input);
    const result = item.spoken || prepared.needsFormatting ? await formatForBoard(item.input, { spoken: item.spoken }) : { text: prepared.pages[0], model: 'none', cost: 0 };
    const lines = result.text.split('\n'), cells = lines.map(line => noteCells(line).length);
    const raw = noteLayout(result.text).flat();
    const errors = item.checks.filter(check => !check.test(result.text)).map(String);
    if (item.exact && result.text !== item.exact) errors.push('exact short text changed');
    if (item.excludes?.test(result.text)) errors.push('meaning reversed');
    if (item.rows && lines.length !== item.rows) errors.push('underused rows');
    if (item.minCells && cells.reduce((sum, n) => sum + n, 0) < item.minCells) errors.push('overcompressed');
    if (item.sameLine && !lines.some(line => line.includes(item.sameLine))) errors.push('split familiar phrase');
    if (item.color && raw.filter(code => code === item.color).length < (item.colorCount || 1)) errors.push('requested color missing');
    const grid = noteLayout(result.text, { decorate: true, seed: item.name });
    if (grid.length !== 3 || grid.some(row => row.length !== 15)) errors.push('invalid device geometry');
    results.push({ name: item.name, passed: !errors.length, text: result.text, cells, model: result.model, cost: result.cost, milliseconds: Date.now() - start, errors });
  } catch (error) { results.push({ name: item.name, passed: false, errors: [error.message] }); }
}
const report = { evaluatedAt: new Date().toISOString(), passed: results.filter(r => r.passed).length, total: results.length, reportedSuccessfulCallCost: results.reduce((sum, r) => sum + (r.cost || 0), 0), results };
if (process.env.EVAL_REPORT) await writeFile(process.env.EVAL_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.passed !== report.total) process.exitCode = 1;
