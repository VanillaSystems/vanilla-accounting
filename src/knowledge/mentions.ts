import ts from 'typescript';
import type { Counterparty } from './counterparties.js';

/** Words that, in a rule or in code, mean the text is about one counterparty. */
export function namesOf(cp: Pick<Counterparty, 'name' | 'id' | 'match'>): string[] {
  return [...new Set([cp.name.split(/[(,]/)[0].trim(), cp.id.replace(/-/g, ' '), ...cp.match.tx].map((n) => n.toLowerCase()))]
    .filter((n) => n.length >= 3);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first of `names` that `text` contains as whole words, so "ups" is not found in "groups".
 * The words of a name may be joined by a space, "-" or "_" ("coop-pronto").
 */
export function mentionIn(text: string, names: string[]): string | undefined {
  return names.find((n) => new RegExp(`\\b${n.split(/\s+/).map(escape).join('[\\s_-]+')}\\b`, 'i').test(text));
}

/**
 * The code of a TypeScript source as words: comments dropped (a vendor named in a comment encodes
 * no rule), a regex's \s read as a space ("coop\s*pronto"), and once more with camelCase split
 * ("usesShopifyAccount"), kept beside the unsplit text so "FedEx" still reads as one word.
 */
export function codeWords(source: string, fileName = 'source.ts'): string {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  const code = ts.createPrinter({ removeComments: true }).printFile(file).replace(/\\s[*+?]?/g, ' ');
  return `${code}\n${code.replace(/([a-z\d])([A-Z])/g, '$1 $2')}`;
}

/** Ids of the counterparties that a source file's code (not its comments) names. */
export function counterpartiesNamedIn(source: string, fileName: string, counterparties: Counterparty[]): string[] {
  const code = codeWords(source, fileName);
  return counterparties.filter((cp) => mentionIn(code, namesOf(cp))).map((cp) => cp.id);
}
