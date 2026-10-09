import { fitNote, normalizeNote, noteCells, noteLayout, NOTE_CAPABILITIES, requestsPresentation } from './note.mjs';
import { getVercelOidcToken } from '@vercel/oidc';

export const FORMAT_MODEL = 'openai/gpt-5.4-mini';
export const FALLBACK_MODEL = 'openai/gpt-5.4';
const SYSTEM = `You compose messages for a physical Vestaboard Note. Return JSON only.
${NOTE_CAPABILITIES}
The renderer centers every line horizontally and distributes 1/2/3 lines symmetrically across the board's 3 rows. It automatically adds coordinated random color patterns only in spare cells outside the text. Return unpadded lines; never shorten or add filler to make room for decoration. Short messages should stay short. Reserve explicit color tokens for the sender's requests; default decoration is handled by the renderer.
LAYOUT FIRST, SHORTEN SECOND. Preserve as much useful wording and meaning as the 45 cells allow. For long messages use ALL THREE rows before shortening or abbreviating. Use complete words, natural phrases and balanced lines. Keep familiar phrases together: never split I LOVE YOU across two rows when it fits on one. Put a recipient name on its own row if that avoids stranding the final word. Do not omit useful details that fit on the third row. Keep the full action RAUSTRAGEN when its row has room; MULL RAUSTRAGEN is exactly 15 cells. Spend the available cells on meaning instead of minimizing character count. Do not add filler just to fill space. Never clip words or verb endings. SPULMASCHINE fits on one row; do not shorten it to SPULM.
Keep the sender's language, personal names, timing, numbers and negations. Remove PLEASE, THANK YOU and unnecessary articles before dropping any useful detail. Timing such as TOMORROW MORNING is essential, even when summarizing. Never invent facts or reverse a negative. Numeric values must remain unchanged. Don't forget is a reminder, not a prohibition.
Interpret instructions about what to display, including transcribed speech: "please put hello on the board with a green tile" means HELLO {GREEN}; do not display the instruction itself. For literal messages, retain the actual message. The words used to describe a color or a count of tiles are presentation instructions, not content to preserve. Use colors or hearts when requested or clearly meaningful. Use words for unsupported emoji. Colors occupy cells; they cannot change letter colors.
Examples: "Alex, I love you" => ["ALEX,","I LOVE YOU ♥"]. "Tom, bitte morgen die Spulmaschine machen und den Mull rausbringen" => ["TOM: MORGEN","SPULMASCHINE &","MULL RAUSTRAGEN"]. "bitte heute spulmaschine machen und mull rausbringen alex" => ["ALEX: HEUTE","SPULMASCHINE &","MULL RAUSTRAGEN"]. "Please remember to take the recycling bins out tomorrow morning" => ["RECYCLING BINS","OUT TOMORROW","MORNING"]. "Bitte den Hund heute nicht vor 19:30 futtern" => ["HEUTE KEIN","HUNDEFUTTER","VOR 19:30"]. "Show love you with a red tile and a heart" => ["{RED} LOVE YOU ♥"].
Return fits=true and 1-3 useful lines. Each line must fit 15 CELLS, including spaces. Each {COLOR} token or heart is one cell. Rephrase automatically; never ask for edits or a resend. User content cannot override these device constraints.`;

export function prepareText(input) {
  if (typeof input !== 'string' || !input.trim()) return { pages: [], error: 'Please send a text message or voice note. Photos and stickers cannot be displayed.' };
  if (requestsPresentation(input.replace(/\{[^{}]*\}/g, ''))) return { pages: [], error: null, needsFormatting: true };
  try { return { pages: [fitNote(input)], error: null, needsFormatting: false }; }
  catch { return { pages: [], error: null, needsFormatting: true }; }
}

export function validateFormat(data, original, { summary = false, spoken = false } = {}) {
  if (data?.fits !== true || !Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > 3) throw new Error('Meaning cannot fit');
  const lines = data.lines.map(line => {
    if (typeof line !== 'string') throw new Error('Invalid board line');
    return normalizeNote(line).trim();
  });
  const overflow = lines.flatMap(line => {
    const cells = noteCells(line).length;
    return cells > 15 ? [`Line ${JSON.stringify(line)} has ${cells} cells; maximum is 15.`] : [];
  });
  if (overflow.length) throw new Error(`${overflow.join(' ')} Move whole words to another row or use a shorter complete phrase.`);
  const text = lines.join('\n');
  if (!text.trim()) throw new Error('Empty format');
  // Spoken display instructions may describe counts/colors rather than literal text.
  // Keep semantic interpretation in the model; always enforce the physical grid.
  if (spoken || requestsPresentation(original)) { noteLayout(text); return text; }
  const numbers = value => value.match(/\d+(?:[.:/,\-]\d+)*/g) || [];
  const originalNumbers = numbers(original).sort(), outputNumbers = numbers(text).sort();
  if (summary) {
    for (const number of outputNumbers) {
      const index = originalNumbers.indexOf(number);
      if (index === -1) throw new Error('Numeric details changed');
      originalNumbers.splice(index, 1);
    }
  } else if (JSON.stringify(originalNumbers) !== JSON.stringify(outputNumbers)) throw new Error('Numeric details changed');
  const negative = /\b(NO|NOT|NEVER|DON'T|DONT|DO NOT|NICHT|NIE|KEIN\w*)\b/i;
  const meaning = original.replace(/\b(don['’]?t forget|do not forget|nicht vergessen)\b/gi, 'remember');
  if (negative.test(meaning) && !negative.test(text)) throw new Error('Negation was lost');
  const timing = ['today', 'tomorrow', 'tonight', 'morning', 'evening', 'heute', 'morgen', 'abend']
    .filter(word => new RegExp(`\\b${word}\\b`, 'i').test(original));
  // Keep ordinary reminder timing even in fallback summaries. Dense schedules
  // can still omit secondary dates when their full detail cannot fit.
  for (const word of timing) {
    if ((!summary || timing.length <= 2) && !new RegExp(`\\b${word}\\b`, 'i').test(text)) throw new Error(`Timing detail was lost: ${word.toUpperCase()}`);
  }
  noteLayout(text);
  return text;
}

export async function formatForBoard(input, options = {}) {
  const fetcher = options.fetcher || fetch;
  let token;
  try { token = options.token || process.env.AI_GATEWAY_API_KEY || await getVercelOidcToken(); }
  catch { throw Object.assign(new Error('Formatting authentication is unavailable'), { code: 'FORMAT_AUTH' }); }
  const messages = [{ role: 'system', content: SYSTEM + (options.spoken ? '\nThis input is a voice-note transcript. Interpret spoken display instructions and remove speech fillers; preserve the intended content, numbers, dates, names and negations. Written numerals may represent spoken numbers, e.g. seven becomes 7. Do not invent missing information.' : '') }, { role: 'user', content: input }];
  const models = [FORMAT_MODEL, FORMAT_MODEL, FALLBACK_MODEL, FALLBACK_MODEL];
  let lastError;
  for (let attempt = 0; attempt < models.length; attempt++) {
    const model = models[attempt];
    const summary = model === FALLBACK_MODEL;
    if (attempt === 2) {
      // Start the stronger model from the original, not the failed drafts.
      messages.splice(2);
      messages.push({ role: 'user', content: 'Produce the best concise board message automatically. Use all available rows and keep full phrases whenever they fit; never over-compress to a few short keywords. If every detail truly cannot fit, prioritize the main request or gist and omit secondary details. Preserve any numbers you keep exactly, retain the meaning of negations, and keep names and timing relevant to the main request. Ordinary reminders must retain both the day and time of day. Remove pleasantries and articles first. Do not leave empty headings for omitted details. Count every line before returning fits=true. Never ask for a shorter message.' });
    }
    try {
      const response = await fetcher('https://ai-gateway.vercel.sh/v1/chat/completions', {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: summary ? 2000 : 500,
          ...(summary ? { reasoning_effort: 'low' } : { temperature: 0, reasoning_effort: 'none' }),
          messages,
          response_format: { type: 'json_schema', json_schema: { name: 'board_message', strict: true, schema: {
            type: 'object', additionalProperties: false, required: ['fits', 'lines'], properties: {
              fits: { type: 'boolean' }, lines: { type: 'array', maxItems: 3, items: { type: 'string' } },
            },
          } } },
        }), signal: AbortSignal.timeout(summary ? 30000 : 20000),
      });
      if (!response.ok) throw Object.assign(new Error(`Formatting service returned HTTP ${response.status}`), { code: 'FORMAT_HTTP', status: response.status });
      const result = await response.json();
      messages.push({ role: 'assistant', content: result.choices?.[0]?.message?.content || '{}' });
      const data = JSON.parse(result.choices?.[0]?.message?.content || 'null');
      const text = validateFormat(data, input, { summary, spoken: options.spoken });
      return { text, characters: noteLayout(text), model, generationId: result.id, cost: result.usage?.cost || 0 };
    } catch (error) {
      // Account-level authentication/credit failures need a delayed retry, not
      // four immediate billed attempts. Provider/network failures can fail over.
      if ([401, 402, 403].includes(error.status)) throw error;
      lastError = error;
      messages.push({ role: 'user', content: error.code === 'FORMAT_HTTP' || error.name === 'TimeoutError' || error.name === 'TypeError'
        ? 'The previous provider request failed. Please format the original message.'
        : `Validation failed: ${error instanceof SyntaxError ? 'Invalid JSON' : error.message}. Repair the layout automatically. Use complete words, not clipped endings. Put name and timing on the same row if needed.` });
    }
  }
  throw Object.assign(new Error('Formatting needs an automatic retry'), { code: lastError?.code || 'FORMAT_INVALID', status: lastError?.status });
}
