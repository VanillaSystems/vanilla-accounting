import { mailAccounts, fetchEmailSummaries, fetchEmailFull, parseQuarter, getQuarterArg, type EmailSummary } from './imap.js';
import { classifyDomain, loadMailConfig } from './mail-config.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';
import { useKeychain } from '../secrets/keychain-store.js';

useKeychain(() => openWorkspace().paths.root);
const MAIL = loadMailConfig(openWorkspace());
const ACCOUNTS = await mailAccounts(MAIL);

const { inbox: IMPORT_DIR, data: JOURNAL_DIR } = openWorkspace().paths;
const JOURNAL_PATH = join(JOURNAL_DIR, 'download-journal.json');

interface JournalEntry {
  account: string;
  uid: number;
  filename: string;
  savedAs: string;
  date: string;       // email date
  downloadedAt: string; // when we downloaded it
}

function loadJournal(): JournalEntry[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8'));
}

function saveJournal(entries: JournalEntry[]): void {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(JOURNAL_PATH, JSON.stringify(entries, null, 2) + '\n');
}

function isInJournal(journal: JournalEntry[], account: string, uid: number, filename: string): boolean {
  return journal.some(e => e.account === account && e.uid === uid && e.filename === filename);
}

async function main() {
  const quarter = getQuarterArg();
  const { from, to } = parseQuarter(quarter);
  console.log(`${quarter}:`, from.toISOString(), 'to', to.toISOString());

  // Collect all business + ambiguous emails with attachments
  const toFetch: { account: Awaited<ReturnType<typeof mailAccounts>>[number]; summary: EmailSummary }[] = [];

  // COLLECT_ACCOUNTS=<label>,<label> restricts the run to specific
  // accounts — needed because Gmail app-specific passwords get revoked between
  // sessions, and a dead account must not block collecting from the others.
  const only = (process.env.COLLECT_ACCOUNTS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const accounts = only.length ? ACCOUNTS.filter(a => only.includes(a.label)) : ACCOUNTS;
  if (only.length) console.log(`Accounts limited to: ${accounts.map(a => a.label).join(', ')}`);
  const failedAccounts: string[] = [];

  for (const account of accounts) {
    console.log(`\nFetching from ${account.label}...`);
    let summaries: EmailSummary[];
    try {
      summaries = await fetchEmailSummaries(account, from, to);
    } catch (e: any) {
      console.error(`  !! ${account.label} failed: ${e?.code ?? ''} ${e?.message ?? e}`);
      console.error(`     skipping this account — rerun it later with COLLECT_ACCOUNTS=${account.label}`);
      failedAccounts.push(account.label);
      continue;
    }

    for (const s of summaries) {
      if (!s.hasAttachments) continue;

      // Gmail filtering
      if (account.mixed) {
        const domainMatch = s.from.match(/@([^>]+)/);
        const domain = domainMatch ? domainMatch[1].toLowerCase() : '';
        if (classifyDomain(domain, MAIL) === 'skip') continue;
      }

      toFetch.push({ account, summary: s });
    }
  }

  console.log(`\n${toFetch.length} emails with attachments to check\n`);

  const journal = loadJournal();
  console.log(`Journal has ${journal.length} previous downloads.\n`);

  let downloaded = 0;
  let skippedJournal = 0;
  let skippedOther = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const { account, summary } = toFetch[i];
    const prefix = `[${i + 1}/${toFetch.length}]`;

    console.log(`${prefix} ${summary.date.substring(0, 10)} ${summary.from.substring(0, 40)} | ${summary.subject.substring(0, 50)}`);

    let full: Awaited<ReturnType<typeof fetchEmailFull>>;
    try {
      full = await fetchEmailFull(account, summary.uid);
    } catch (e: any) {
      console.error(`  !! fetch failed (uid ${summary.uid}): ${e?.message ?? e}`);
      skippedOther++;
      continue;
    }

    for (const att of full.attachments) {
      const name = att.filename.toLowerCase();
      // Only save PDFs
      if (!name.endsWith('.pdf')) {
        console.log(`  skip: ${att.filename} (not PDF)`);
        skippedOther++;
        continue;
      }

      // Check journal first (survives file renames/moves)
      if (isInJournal(journal, account.label, summary.uid, att.filename)) {
        console.log(`  journal: ${att.filename} (already downloaded)`);
        skippedJournal++;
        continue;
      }

      // Build a descriptive filename: date_sender_originalname.pdf
      const dateStr = summary.date.substring(0, 10).replace(/-/g, '');
      const senderDomain = (summary.from.match(/@([^>]+)/) || ['', 'unknown'])[1]
        .replace(/\.[a-z]+$/, '').replace(/[^a-zA-Z0-9.-]/g, '_');
      const safeName = att.filename.replace(/[/\\:*?"<>|]/g, '-');
      const targetName = `${dateStr}_${senderDomain}_${safeName}`;
      const targetPath = join(IMPORT_DIR, targetName);

      // Fallback: also check if file exists on disk
      if (existsSync(targetPath)) {
        console.log(`  exists: ${targetName}`);
        // Record in journal so next run skips faster
        journal.push({
          account: account.label, uid: summary.uid,
          filename: att.filename, savedAs: targetName,
          date: summary.date, downloadedAt: new Date().toISOString(),
        });
        skippedOther++;
        continue;
      }

      writeFileSync(targetPath, att.content);
      journal.push({
        account: account.label, uid: summary.uid,
        filename: att.filename, savedAs: targetName,
        date: summary.date, downloadedAt: new Date().toISOString(),
      });
      console.log(`  saved: ${targetName} (${(att.content.length / 1024).toFixed(0)} KB)`);
      downloaded++;
    }
  }

  saveJournal(journal);
  console.log(`\nDone. Downloaded ${downloaded}, skipped ${skippedJournal} (journal) + ${skippedOther} (other).`);
  if (failedAccounts.length) {
    console.log(`\n⚠ Incomplete — these accounts were NOT collected: ${failedAccounts.join(', ')}`);
    console.log(`  Rerun: COLLECT_ACCOUNTS=${failedAccounts.join(',')} npm run collect -- ${quarter}`);
    process.exitCode = 3;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
