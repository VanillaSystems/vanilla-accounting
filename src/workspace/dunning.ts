/**
 * The Mahnwesen's settings (docs/specs/invoicing.md 4.4.7), read by the manifest and by invoicing:
 * the Mahnstufen, default interest, a new firm's levels, the levels every firm had before them
 * (manifest step 6 → 7), and `invoicing.dunning` checked at the boundary. Pure, no jurisdiction: the
 * rules of a Mahnung are src/invoices/dunning.ts; src/invoices/model.ts re-exports the types.
 */

/** The languages a document is written in (src/invoices/model.ts INVOICE_LANGUAGES). */
const LANGUAGES = ['de', 'fr', 'it', 'en'] as const;
type Language = (typeof LANGUAGES)[number];

/** A Mahnstufe's own texts in one language; each absent: the app's. Placeholders: {number}, {date}, {due}, {days}, {previous}; in the mail {document}, {company}. */
export interface DunningTexts { title?: string; intro?: string; closing?: string; mailSubject?: string; mailBody?: string }

/**
 * A Mahnstufe (spec 4.4.7): its name (the paper's title, unless a language names its own), the days
 * the customer gets to pay, an optional fee, texts per language, and an automatic reminder «N Tage
 * nach Fälligkeit» of what came before (the invoice, or the previous Mahnung).
 */
export interface DunningLevel {
  name: string;
  days: number;
  fee?: number;
  texts?: Partial<Record<Language, DunningTexts>>;
  auto?: { afterDays: number };
}

/** The firm's Mahnwesen: its levels in order, and default interest when it charges it (`rate` percent a year; `account`: absent, the jurisdiction's). */
export interface DunningSettings {
  levels: DunningLevel[];
  interest?: { rate: number; account?: string };
}

/** The titles of a level in fr, it and en (de is its name). */
const titles = (fr: string, it: string, en: string): DunningLevel['texts'] => ({ fr: { title: fr }, it: { title: it }, en: { title: en } });

/** A new firm's Mahnwesen: «Zahlungserinnerung» without a fee, «1. Mahnung», «2. Mahnung», 10 days each, nothing automatic, no interest. */
export const DEFAULT_DUNNING: DunningSettings = {
  levels: [
    { name: 'Zahlungserinnerung', days: 10, texts: titles('Rappel de paiement', 'Promemoria di pagamento', 'Payment reminder') },
    { name: '1. Mahnung', days: 10, texts: titles('1er rappel', '1° sollecito', 'First reminder') },
    { name: '2. Mahnung', days: 10, texts: titles('2e rappel', '2° sollecito', 'Second reminder') },
  ],
};

/**
 * What a firm had before the levels (manifest step 6 → 7): three Mahnungen with the words they
 * printed in each language (src/invoices/texts.ts `reminder`), 10 days to pay, the fee asked each time.
 */
export const LEGACY_DUNNING: DunningSettings = {
  levels: [
    { name: '1. Mahnung', days: 10, texts: titles('1er rappel', '1° sollecito', 'Payment reminder') },
    { name: '2. Mahnung', days: 10, texts: titles('2e rappel', '2° sollecito', 'Second reminder') },
    { name: '3. Mahnung', days: 10, texts: titles('3e rappel', '3° sollecito', 'Final reminder') },
  ],
};

// ─── the settings at the boundary ────────────────────────────────────────────

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const DUNNING_TEXTS = ['title', 'intro', 'closing', 'mailSubject', 'mailBody'] as const;

/**
 * `invoicing.dunning` of belege.workspace.yaml, or the body Firma › Verkauf › Mahnwesen saves:
 * `{ levels: [{ name, days, fee?, texts?, auto?: { afterDays } }], interest?: { rate, account? } }`.
 * Absent: DEFAULT_DUNNING. `fail` names what is wrong.
 */
export function readDunning(raw: unknown, fail: (msg: string) => never, where = 'invoicing.dunning'): DunningSettings {
  if (raw === undefined) return structuredClone(DEFAULT_DUNNING);
  if (!isMap(raw)) return fail(`${where} must be { levels, interest? }`);
  if (!Array.isArray(raw.levels) || raw.levels.length === 0) return fail(`${where}.levels must list at least one level { name, days }`);
  if (raw.levels.length > 9) return fail(`${where}.levels: at most 9 levels`);
  const levels = raw.levels.map((l, i): DunningLevel => {
    const at = `${where}.levels[${i}]`;
    if (!isMap(l)) return fail(`${at} must be { name, days, fee?, texts?, auto? }`);
    const name = typeof l.name === 'string' ? l.name.trim() : '';
    if (!name) fail(`${at}.name is missing`);
    if (!Number.isInteger(l.days) || (l.days as number) < 0 || (l.days as number) > 365) fail(`${at}.days must be whole days from 0 to 365`);
    if (l.fee !== undefined && (typeof l.fee !== 'number' || !Number.isFinite(l.fee) || l.fee < 0)) fail(`${at}.fee must be an amount from 0`);
    let texts: DunningLevel['texts'];
    if (l.texts !== undefined) {
      if (!isMap(l.texts)) fail(`${at}.texts must map a language to { ${DUNNING_TEXTS.join(', ')} }`);
      texts = {};
      for (const [lang, v] of Object.entries(l.texts as Record<string, unknown>)) {
        if (!LANGUAGES.includes(lang as Language) || !isMap(v)) fail(`${at}.texts.${lang}: one of ${LANGUAGES.join(', ')}, with ${DUNNING_TEXTS.join(', ')}`);
        const t: DunningTexts = {};
        for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
          if (!(DUNNING_TEXTS as readonly string[]).includes(k) || typeof s !== 'string') fail(`${at}.texts.${lang}.${k}: one of ${DUNNING_TEXTS.join(', ')}, a text`);
          if ((s as string).trim()) t[k as keyof DunningTexts] = s as string;
        }
        if (Object.keys(t).length) texts[lang as Language] = t;
      }
    }
    let auto: DunningLevel['auto'];
    if (l.auto !== undefined && l.auto !== null) {
      const a = l.auto;
      if (!isMap(a) || !Number.isInteger(a.afterDays) || (a.afterDays as number) < 0 || (a.afterDays as number) > 365) fail(`${at}.auto must be { afterDays } (whole days from 0 to 365)`);
      auto = { afterDays: (a as { afterDays: number }).afterDays };
    }
    return { name, days: l.days as number, ...(l.fee ? { fee: l.fee as number } : {}), ...(texts && Object.keys(texts).length ? { texts } : {}), ...(auto ? { auto } : {}) };
  });
  let interest: DunningSettings['interest'];
  if (raw.interest !== undefined && raw.interest !== null) {
    const i = raw.interest;
    if (!isMap(i) || typeof i.rate !== 'number' || !(i.rate > 0 && i.rate <= 30)) fail(`${where}.interest must be { rate (a percent above 0, at most 30), account? }`);
    const m = i as Record<string, unknown>;
    if (m.account !== undefined && (typeof m.account !== 'string' || !/^\d{3,6}$/.test(m.account))) fail(`${where}.interest.account must be an account number`);
    interest = { rate: m.rate as number, ...(m.account ? { account: m.account as string } : {}) };
  }
  return { levels, ...(interest ? { interest } : {}) };
}

/** The texts a level may carry of its own, per language. */
export const LEVEL_TEXTS: readonly string[] = DUNNING_TEXTS;
