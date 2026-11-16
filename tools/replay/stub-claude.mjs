#!/usr/bin/env node
// Stands in for the `claude` CLI in a replay's dry run (npm run replay -- run <folder> --stub): the
// app's real code runs, no model is called. Each prompt gets an answer in the format its step asks
// for that decides as little as it can, so the app takes the answer and does not ask again (as it
// would not after a real answer), and the person (the oracle) does the rest:
// - a match: the file's name, no payment, confidence 0 (the receipt is filed, linked to nothing);
// - the VAT facts: no tax shown;
// - a booking: every payment on $REPLAY_STUB_ACCOUNT (6570 when unset), no VAT code, which the oracle corrects;
// - the text of a scan: a line that says nothing (a model's reading, so it is not read again);
// - anything else (what a document is, titles): nothing («{}»).
// Its usage is an estimate: input tokens = the prompt's characters / 4 (attachments not counted),
// output 0, so the dry run's ledger counts the calls and gives the prompts' size.
// $REPLAY_STUB_LOG: each call's model, prompt size and first line are appended there.
import { appendFileSync, readFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0 (replay stub)\n');
  process.exit(0);
}
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }));
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
const model = process.argv[process.argv.indexOf('--model') + 1] ?? '?';
if (process.env.REPLAY_STUB_LOG) appendFileSync(process.env.REPLAY_STUB_LOG, `${model}\t${prompt.length}\t${prompt.split('\n').find((l) => l.trim())?.slice(0, 100) ?? ''}\n`);
const usage = { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function bookings() {
  const account = process.env.REPLAY_STUB_ACCOUNT || '6570';
  const out = {};
  for (const section of prompt.split('## Chart of Accounts')[0].split(/^### Transaction \d+: /m).slice(1)) {
    const ref = section.split('\n')[0].trim();
    const amount = Number(section.match(/Amount: (-?[\d.]+) /)?.[1] ?? 0);
    out[ref] = { entries: [{ accountDebit: account, accountCredit: '', amount, vatCode: '', description: 'Replay stub' }] };
  }
  return out;
}

const result = prompt.includes('## Chart of Accounts') && /^### Transaction \d+: /m.test(prompt) ? JSON.stringify(bookings())
  : prompt.includes('"matchedTransactionRefs"') ? JSON.stringify({ suggestedFilename: '00000000-replay-stub.pdf', matchedTransactionRefs: [], date: '', description: 'Replay stub', amount: 0, currency: '', confidence: 0 })
  : prompt.includes('"vatSummary"') ? JSON.stringify({ vatId: '', currency: '', hasSwissVat: false, vatSummary: [] })
  : /Extrahiere den vollständigen Text|full text/i.test(prompt) ? 'Replay stub: nothing read.'
  : '{}';
process.stdout.write(JSON.stringify({ type: 'result', result, is_error: false, num_turns: 1, usage }));
