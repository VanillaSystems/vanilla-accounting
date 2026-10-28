/**
 * Does the pdf.js text extractor (src/parsers/pdf-text.ts) give the parsers what `pdftotext`
 * gave them? For every PDF under the workspace folders named, both paths are run and what the
 * app READS off the text is compared, not the text itself:
 *
 *   receipts/, beleg-import/, invoices/: the intake's verdicts (digital or needs vision, short
 *     enough for the vision match, Swiss UID(s), VAT indicator, VAT-proof trap, grouped vendor,
 *     foreign hint, the document type a knowledge file assigns, the casebook keywords that hit,
 *     and the Shopify order page's figures)
 *
 * Statement PDFs are no longer read by text parsers: the model reads them (#217).
 *
 *   npx tsx tools/pdf-text/compare.ts <out-dir> <workspace>...
 *
 * Prints counts only. <out-dir>/<workspace-name>.json lists each file's verdicts under both
 * paths and `differences` names the files and signals that differ; keep it out of the repo
 * (.verify/ is gitignored) when the workspace is a real company's.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { FOREIGN_HINT, loadCases } from '../../src/knowledge/cases.js';
import { documentTypeOf, uidsIn, type Counterparty } from '../../src/knowledge/counterparties.js';
import { loadKnowledge } from '../../src/knowledge/layers.js';
import { pdfText, type TextMode } from '../../src/parsers/pdf-text.js';
import { detectVatProofIssue, hasSwissUid, hasVatIndicator } from '../../src/parsers/receipt-text.js';
import { APP_ROOT } from '../../src/workspace/workspace.js';

const execFileAsync = promisify(execFile);

const POPPLER_FLAGS: Record<TextMode, string[]> = { reading: [], raw: ['-raw'], layout: ['-layout'] };

async function poppler(file: string, mode: TextMode): Promise<string> {
  const { stdout } = await execFileAsync('pdftotext', [...POPPLER_FLAGS[mode], '-enc', 'UTF-8', file, '-'], { maxBuffer: 1 << 26 });
  return stdout;
}

type Verdicts = Record<string, unknown>;

/** What src/cli/extract.ts, extract-vat, match and the knowledge layer read off a receipt's text. */
function receiptVerdicts(file: string, text: string, counterparties: readonly Counterparty[], keywords: readonly string[]): Verdicts {
  const t = text.trim();
  const lower = t.toLowerCase();
  return {
    digital: t.length > 30,
    visionMatch: t.length < 200,
    tooShortForVat: t.length < 20,
    swissUid: hasSwissUid(t),
    uids: uidsIn({ extractedText: t }).sort(),
    vatIndicator: hasVatIndicator(t),
    vatProofIssue: detectVatProofIssue(t) !== undefined,
    groupedVendor: t.match(/amazon|aliexpress|fedex/i)?.[0].toLowerCase() ?? null,
    foreignHint: FOREIGN_HINT.test(t),
    documentType: documentTypeOf({ extractedText: t }, counterparties),
    caseKeywords: keywords.filter((kw) => lower.includes(kw)),
  };
}

function pdfsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pdfsUnder(p) : f.toLowerCase().endsWith('.pdf') ? [p] : [];
  });
}

/** The folders of a workspace whose PDFs the app reads. */
const FOLDERS = ['receipts', 'beleg-import', 'invoices'];

interface FileResult { file: string; old: Verdicts; new: Verdicts; differs: string[] }

async function compareWorkspace(root: string): Promise<{ results: FileResult[]; failures: string[] }> {
  const counterparties = loadKnowledge(APP_ROOT, root).counterparties;
  const keywords = [...new Set(loadCases().flatMap((c) => c.signals.keywords))];
  const results: FileResult[] = [];
  const failures: string[] = [];
  for (const file of FOLDERS.flatMap((f) => pdfsUnder(join(root, f)))) {
    try {
      const verdicts = async (read: (mode: TextMode) => Promise<string>): Promise<Verdicts> => {
        return receiptVerdicts(file, await read('reading'), counterparties, keywords);
      };
      const [oldV, newV] = await Promise.all([verdicts((m) => poppler(file, m)), verdicts((m) => pdfText(file, m))]);
      const differs = Object.keys(oldV).filter((k) => JSON.stringify(oldV[k]) !== JSON.stringify(newV[k]));
      results.push({ file: relative(root, file), old: oldV, new: newV, differs });
    } catch (e) {
      failures.push(`${relative(root, file)}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return { results, failures };
}

async function main(): Promise<void> {
  const [outDir, ...roots] = process.argv.slice(2);
  if (!outDir || roots.length === 0) {
    console.error('usage: npx tsx tools/pdf-text/compare.ts <out-dir> <workspace>...');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  let exit = 0;
  for (const root of roots) {
    const { results, failures } = await compareWorkspace(root);
    const equal = results.filter((r) => r.differs.length === 0).length;
    const bySignal = new Map<string, number>();
    for (const r of results) for (const k of r.differs) bySignal.set(k, (bySignal.get(k) ?? 0) + 1);
    const name = basename(root);
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify({
      root, files: results.length, equal, failures,
      differences: results.filter((r) => r.differs.length).map((r) => ({ file: r.file, differs: r.differs, old: r.old, new: r.new })),
    }, null, 2));
    console.log(`${name}: ${results.length} PDFs, ${equal} equal, ${results.length - equal} different, ${failures.length} failed to read`);
    for (const [k, n] of [...bySignal].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
    if (equal < results.length || failures.length) exit = 1;
  }
  process.exit(exit);
}

main();
