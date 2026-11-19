/**
 * «Importieren» of Verkauf (Kontakte, Artikel): a CSV read as UTF-8, else Windows-1252, its columns
 * mapped (code proposes the mapping, the person changes any column), each row as it would come in
 * with its problems and its duplicate, then the import. One dialog; each import names its fields,
 * its columns and its words (src/invoices/table-import.ts on the server).
 */
import { useState, type ReactNode } from 'react';
import { IMPORT_LIMIT, type ImportChoice } from '../../../invoices/table-import.js';
import { errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { decodeText } from '../../../core/files.js';
import type { Nav } from '../index.js';
import { Frame, close } from './frame.js';
import { reloadInvoices } from './data.js';

export interface ImportedRow { line: number; choice: ImportChoice }
export interface Preview<R extends ImportedRow> { header: string[]; mapping: Record<string, string | undefined>; rows: R[]; leftOut: number }

export interface ImportKind<R extends ImportedRow> {
  label: string; title: string; text: string;
  fields: readonly string[]; fieldLabel: (field: string) => string;
  preview: (csv: string, mapping?: Record<string, string>) => Promise<Preview<R>>;
  run: (csv: string, mapping: Record<string, string>, choices: Record<string, ImportChoice>) => Promise<{ created: number; skipped: number }>;
  /** The toast after the import. */
  done: (created: number, skipped: number) => string;
  count: (n: number, of: number) => string;
  runLabel: (n: number) => string;
  /** The columns of a row after its line: a header and the cell. */
  columns: ReadonlyArray<readonly [string, (r: R) => ReactNode]>;
  /** A row's problems and its duplicate, in words. */
  notes: (r: R) => ReactNode;
  /** A row that is not imported whatever the person picks. */
  blocked: (r: R) => boolean;
  hasSame: (r: R) => boolean;
  newWord: string;
}

export function TableImport<R extends ImportedRow>({ kind, nav }: { kind: ImportKind<R>; nav: Nav }) {
  const [csv, setCsv] = useState<string>();
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState<Preview<R>>();
  const [mapping, setMapping] = useState<Record<string, string>>();
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({});
  const [error, setError] = useState<string>();

  async function read(text: string, map?: Record<string, string>) {
    try {
      const p = await kind.preview(text, map);
      setPreview(p); setMapping(Object.fromEntries(Object.entries(p.mapping).filter((e): e is [string, string] => !!e[1]))); setError(undefined);
    } catch (e) { setError(errorText(e)); }
  }
  async function pickFile(f: File | undefined) {
    if (!f) return;
    // UTF-8, else Windows-1252 (an export of an older program often is): the umlauts come in as written.
    const text = decodeText(new Uint8Array(await f.arrayBuffer()));
    setFile(f.name); setCsv(text); setChoices({});
    await read(text);
  }
  async function run() {
    if (!csv || !mapping) return;
    try {
      const out = await kind.run(csv, mapping, choices);
      close();
      await reloadInvoices();
      nav.toast(kind.done(out.created, out.skipped));
    } catch (e) { setError(errorText(e)); }
  }
  const rows = preview?.rows ?? [];
  const choiceOf = (r: R) => choices[String(r.line)] ?? r.choice;
  const coming = rows.filter((r) => choiceOf(r) === 'new' && !kind.blocked(r)).length;
  return (
    <Frame className="wide cimport" label={kind.label} title={file || kind.title}
      foot={<>
        {preview && <span className="allocleft" data-testid="import-count">{kind.count(coming, rows.length)}</span>}
        <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <AsyncButton type="button" className="btn primary" data-act="run-import" disabled={!preview || coming === 0} onClick={run}>{kind.runLabel(coming)}</AsyncButton>
      </>}>
      <div className="ibody">
        <p>{kind.text}</p>
        <input type="file" accept=".csv,text/csv,text/plain" data-testid="import-file" onChange={(e) => { void pickFile(e.target.files?.[0]); }} />
        {error && <p className="warn">{error}</p>}
        {preview && (
          <>
            {preview.leftOut > 0 && <p className="warn" data-testid="import-left-out">{t('contacts.importLeftOut', { n: preview.leftOut, limit: IMPORT_LIMIT })}</p>}
            <h4 className="cfh">{t('contacts.mapping')}</h4>
            <div className="cmap">
              {kind.fields.map((k) => (
                <label key={k} className="lkr"><span>{kind.fieldLabel(k)}</span>
                  <select value={mapping?.[k] ?? ''} data-map={k} onChange={(e) => { const next = { ...mapping }; if (e.target.value) next[k] = e.target.value; else delete next[k]; setMapping(next); void read(csv!, next); }}>
                    <option value="">–</option>
                    {preview.header.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <h4 className="cfh">{t('contacts.importRows')}</h4>
            <table className="alloc cimp">
              <thead><tr><th>{t('contacts.importLine')}</th>{kind.columns.map(([h]) => <th key={h}>{h}</th>)}<th>{t('contacts.importProblems')}</th><th>{t('contacts.importChoice')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line} data-line={r.line}>
                    <td className="mono">{r.line}</td>
                    {kind.columns.map(([h, cell]) => <td key={h}>{cell(r)}</td>)}
                    <td className="m">{kind.notes(r)}</td>
                    <td>
                      {kind.blocked(r) ? <span className="m">{t('contacts.choice.skip')}</span> : (
                        <select value={choiceOf(r)} data-choice={r.line} onChange={(e) => setChoices({ ...choices, [String(r.line)]: e.target.value as ImportChoice })}>
                          <option value="new">{kind.newWord}</option>
                          {kind.hasSame(r) && <option value="same">{t('contacts.choice.same')}</option>}
                          <option value="skip">{t('contacts.choice.skip')}</option>
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Frame>
  );
}
