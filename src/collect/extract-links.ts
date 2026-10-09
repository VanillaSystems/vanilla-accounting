import { mailAccounts, fetchEmailSummaries, fetchEmailFull, parseQuarter, getQuarterArg, type EmailSummary } from './imap.js';
import { classifyDomain, loadMailConfig } from './mail-config.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';

const MAIL = loadMailConfig(openWorkspace());
const ACCOUNTS = mailAccounts(MAIL);

// Subject patterns that suggest invoices/receipts (not marketing)
const RECEIPT_SUBJECT_PATTERNS = [
  /rechnung/i, /invoice/i, /receipt/i, /quittung/i,
  /bestellung/i, /order/i, /payment/i, /zahlung/i,
  /billing/i, /bill for/i, /statement/i,
  /money.*sent/i, /transfer.*sent/i, /money.*received/i,
  /e-dokument/i, /kontoauszug/i,
  /payout/i, /refund/i, /rückerstattung/i,
];

function isReceiptSubject(subject: string): boolean {
  return RECEIPT_SUBJECT_PATTERNS.some(p => p.test(subject));
}

async function main() {
  const quarter = getQuarterArg();
  const { from, to } = parseQuarter(quarter);

  const candidates: { account: ReturnType<typeof mailAccounts>[number]; summary: EmailSummary }[] = [];

  for (const account of ACCOUNTS) {
    console.log(`Fetching from ${account.label}...`);
    const summaries = await fetchEmailSummaries(account, from, to);

    for (const s of summaries) {
      if (s.hasAttachments) continue; // already handled

      const domainMatch = s.from.match(/@([^>]+)/);
      const domain = domainMatch ? domainMatch[1].toLowerCase() : '';

      // Gmail filtering
      if (account.mixed) {
        if (classifyDomain(domain, MAIL) === 'skip') continue;
      }

      // Only fetch from known link-receipt domains with receipt-like subjects
      const isKnownDomain = MAIL.linkReceiptDomains.has(domain);
      const hasReceiptSubject = isReceiptSubject(s.subject);

      if (isKnownDomain && hasReceiptSubject) {
        candidates.push({ account, summary: s });
      }
    }
  }

  console.log(`\n${candidates.length} emails to check for receipt links\n`);

  // Group by domain for readability
  const byDomain = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const domainMatch = c.summary.from.match(/@([^>]+)/);
    const domain = domainMatch ? domainMatch[1].toLowerCase() : '';
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push(c);
  }

  const results: { domain: string; date: string; subject: string; uid: number; account: string; urls: string[] }[] = [];

  for (const [domain, emails] of [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n--- ${domain} (${emails.length} emails) ---`);

    for (const { account, summary } of emails) {
      console.log(`  ${summary.date.substring(0, 10)} ${summary.subject.substring(0, 70)}`);

      // Fetch full email to extract URLs
      const full = await fetchEmailFull(account, summary.uid);
      const body = full.htmlBody || full.textBody;

      // Extract URLs that look like receipt/invoice links
      const urlRegex = /https?:\/\/[^\s"'<>]+/g;
      const allUrls = [...new Set(body.match(urlRegex) || [])];

      // Filter for receipt-relevant URLs
      const receiptUrls = allUrls.filter(u => {
        const lower = u.toLowerCase();
        return lower.includes('invoice') || lower.includes('receipt')
          || lower.includes('rechnung') || lower.includes('billing')
          || lower.includes('statement') || lower.includes('download')
          || lower.includes('pdf') || lower.includes('document')
          || lower.includes('beleg') || lower.includes('quittung')
          || lower.includes('transfer') || lower.includes('payout');
      });

      if (receiptUrls.length > 0) {
        console.log(`    -> ${receiptUrls.length} receipt URL(s) found`);
        for (const url of receiptUrls.slice(0, 3)) {
          console.log(`       ${url.substring(0, 120)}`);
        }
        results.push({
          domain,
          date: summary.date.substring(0, 10),
          subject: summary.subject,
          uid: summary.uid,
          account: account.label,
          urls: receiptUrls,
        });
      }
    }
  }

  const outPath = join(openWorkspace().paths.inbox, `receipt-links-${quarter}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFound ${results.length} emails with receipt links. Saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
