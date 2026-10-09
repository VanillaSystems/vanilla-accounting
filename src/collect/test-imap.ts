import { mailAccounts, fetchEmailSummaries, parseQuarter, getQuarterArg } from './imap.js';
import { loadMailConfig } from './mail-config.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';

const MAIL = loadMailConfig(openWorkspace());
const ACCOUNTS = mailAccounts(MAIL);

async function main() {
  const quarter = getQuarterArg();
  const { from, to } = parseQuarter(quarter);
  console.log(`${quarter}:`, from.toISOString(), 'to', to.toISOString());

  const allSummaries = [];

  for (const account of ACCOUNTS) {
    console.log(`\nFetching from ${account.label}...`);
    const summaries = await fetchEmailSummaries(account, from, to);
    console.log(`Found ${summaries.length} emails`);
    allSummaries.push(...summaries);
  }

  // Group by sender domain
  const bySender = new Map<string, typeof allSummaries>();
  for (const s of allSummaries) {
    const domainMatch = s.from.match(/@([^>]+)/);
    const domain = domainMatch ? domainMatch[1].toLowerCase() : s.from;
    if (!bySender.has(domain)) bySender.set(domain, []);
    bySender.get(domain)!.push(s);
  }

  // Sort by count descending
  const sorted = [...bySender.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`SENDERS BY VOLUME (${sorted.length} unique domains, ${allSummaries.length} total emails)`);
  console.log('='.repeat(80));
  for (const [domain, emails] of sorted) {
    const accounts = [...new Set(emails.map(e => e.account))].join(', ');
    const subjects = [...new Set(emails.map(e => e.subject.substring(0, 60)))].slice(0, 3);
    const attCount = emails.filter(e => e.hasAttachments).length;
    console.log(`\n  ${domain} (${emails.length} emails, ${attCount} with attachments) [${accounts}]`);
    for (const subj of subjects) {
      console.log(`    - ${subj}`);
    }
  }

  // Save full data for later use
  const outPath = join(openWorkspace().paths.inbox, `email-summaries-${quarter}.json`);
  writeFileSync(outPath, JSON.stringify(allSummaries, null, 2));
  console.log(`\nSaved ${allSummaries.length} summaries to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
