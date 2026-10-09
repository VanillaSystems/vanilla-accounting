import { mailAccounts, fetchEmailSummaries, fetchEmailFull, parseQuarter, getQuarterArg } from './imap.js';
import { classifyDomain, loadMailConfig } from './mail-config.js';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';

const MAIL = loadMailConfig(openWorkspace());
const ACCOUNTS = mailAccounts(MAIL);

const IMPORT_DIR = openWorkspace().paths.inbox;

// Check emails that reported hasAttachments=false but might have inline PDFs
async function main() {
  // Quarter is an argument, not a constant — this pass must be repeatable each quarter.
  const quarter = getQuarterArg();
  const { from, to } = parseQuarter(quarter);
  console.log(`${quarter}: looking for inline PDFs that bodyStructure missed`);

  // Same account filter as download-attachments (a revoked Gmail password must
  // not block the other accounts).
  const only = (process.env.COLLECT_ACCOUNTS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const accounts = only.length ? ACCOUNTS.filter(a => only.includes(a.label)) : ACCOUNTS;
  if (only.length) console.log(`Accounts limited to: ${accounts.map(a => a.label).join(', ')}`);
  const failedAccounts: string[] = [];

  // Only check emails with receipt-like subjects from non-skip domains
  const RECEIPT_PATTERNS = [
    /rechnung/i, /invoice/i, /receipt/i, /bestellung.*versandt/i,
    /bill for/i, /ihre bestellung/i, /your order/i,
  ];

  for (const account of accounts) {
    console.log(`\nFetching from ${account.label}...`);
    let summaries;
    try {
      summaries = await fetchEmailSummaries(account, from, to);
    } catch (e: any) {
      console.error(`  !! ${account.label} failed: ${e?.code ?? ''} ${e?.message ?? e}`);
      failedAccounts.push(account.label);
      continue;
    }

    // Filter: no attachments detected, but receipt-like subject
    const candidates = summaries.filter(s => {
      if (s.hasAttachments) return false; // already handled

      if (account.mixed) {
        const domain = (s.from.match(/@([^>]+)/) || ['', ''])[1].toLowerCase();
        if (classifyDomain(domain, MAIL) === 'skip') return false;
      }

      return RECEIPT_PATTERNS.some(p => p.test(s.subject));
    });

    console.log(`  ${candidates.length} candidates to check for hidden PDFs`);

    for (const s of candidates) {
      let full;
      try {
        full = await fetchEmailFull(account, s.uid);
      } catch (e: any) {
        console.error(`    !! fetch failed (uid ${s.uid}): ${e?.message ?? e}`);
        continue;
      }
      const pdfAtts = full.attachments.filter(a =>
        a.filename.toLowerCase().endsWith('.pdf') || a.contentType === 'application/pdf'
      );

      if (pdfAtts.length === 0) continue;

      console.log(`\n  FOUND: ${s.date.substring(0, 10)} ${s.from.substring(0, 40)} | ${s.subject.substring(0, 60)}`);

      for (const att of pdfAtts) {
        const dateStr = s.date.substring(0, 10).replace(/-/g, '');
        const senderDomain = (s.from.match(/@([^>]+)/) || ['', 'unknown'])[1]
          .replace(/\.[a-z]+$/, '').replace(/[^a-zA-Z0-9.-]/g, '_');
        const safeName = att.filename.replace(/[/\\:*?"<>|]/g, '-');
        const targetName = `${dateStr}_${senderDomain}_${safeName}`;
        const targetPath = join(IMPORT_DIR, targetName);

        if (existsSync(targetPath)) {
          console.log(`    exists: ${targetName}`);
          continue;
        }

        writeFileSync(targetPath, att.content);
        console.log(`    saved: ${targetName} (${(att.content.length / 1024).toFixed(0)} KB)`);
      }
    }
  }

  if (failedAccounts.length) {
    console.log(`\n⚠ Incomplete — NOT checked: ${failedAccounts.join(', ')}`);
    console.log(`  Rerun: COLLECT_ACCOUNTS=${failedAccounts.join(',')} npm run collect-missed -- ${quarter}`);
    process.exitCode = 3;
  }
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
