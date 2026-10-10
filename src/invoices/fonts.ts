/**
 * The invoice fonts as @font-face rules with the font files inlined, so a sheet printed by
 * Chromium looks the same on every machine with the same Chromium, whatever fonts are installed
 * (ADR 0012). The files come from the @fontsource packages the app depends on; only the Latin
 * subsets are inlined. Arimo is metrically compatible with Arial and is declared as
 * Liberation Sans, one of the fonts the QR-bill standard allows (swissqrbill names it so).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const FACES: Array<{ pkg: string; family: string; weights: number[] }> = [
  { pkg: '@fontsource/inter', family: 'Inter', weights: [400, 600, 700] },
  { pkg: '@fontsource/arimo', family: 'Liberation Sans', weights: [400, 700] },
];
const SUBSETS = /\/\* [a-z]+-(latin|latin-ext)-\d+-normal \*\//;

let css: string | undefined;

export function invoiceFontCss(): string {
  if (css !== undefined) return css;
  const out: string[] = [];
  for (const { pkg, family, weights } of FACES) {
    const dir = dirname(require.resolve(`${pkg}/package.json`));
    for (const w of weights) {
      const rules = readFileSync(join(dir, `${w}.css`), 'utf8').split(/(?=\/\* )/).filter((r) => SUBSETS.test(r));
      for (const rule of rules) {
        const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(rule)?.[1];
        if (!file) continue;
        const data = readFileSync(join(dir, 'files', file)).toString('base64');
        out.push(rule
          .replace(/font-family: '[^']+'/, `font-family: '${family}'`)
          .replace(/src: [^;]+;/, `src: url(data:font/woff2;base64,${data}) format('woff2');`)
          .replace(/font-display: swap;\n\s*/, ''));
      }
    }
  }
  return (css = out.join('\n'));
}
