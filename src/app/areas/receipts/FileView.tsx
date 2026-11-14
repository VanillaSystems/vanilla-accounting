/**
 * A linked file shown by its type (src/core/files.ts, #523): a PDF as paper, an image as itself, a
 * CSV as a table, text and XML as text, a saved mail as its body, an HTML page in a sandbox; any other
 * type as its name, type and size with a download. The same in the live app and the audit export: the
 * type comes from the file's name, the bytes from `src`, never from the server's content type.
 */
import { useEffect, useState } from 'react';
import { csvRows, decodeText, fileKindOf, type FileKind } from '../../../core/files.js';
import { mailText, type MailText } from '../../../core/mail-text.js';
import { t } from '../../i18n/index.js';
import { Paper } from './Paper.js';

/** The most rows a table shows and the most characters a text shows: the rest is named and downloaded. */
export const MAX_ROWS = 1000;
export const MAX_CHARS = 500_000;

/** No script, no request: a mail's or a page's HTML only shows what it carries. */
const LOCKED = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;

type Loaded =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'table'; rows: string[][]; total: number; bytes: number }
  | { state: 'text'; text: string; total: number; bytes: number }
  | { state: 'mail'; mail: MailText; bytes: number }
  | { state: 'html'; html: string; bytes: number };

/** One character per byte, as mailText reads a mail (TextDecoder's «latin1» is Windows-1252 and changes 0x80–0x9F). */
function binary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

async function load(src: string, kind: FileKind): Promise<Loaded> {
  const res = await fetch(src);
  if (!res.ok) return { state: 'failed' };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (kind.view === 'mail') return { state: 'mail', mail: mailText(binary(bytes)), bytes: bytes.length };
  const text = decodeText(bytes);
  if (kind.view === 'html') return { state: 'html', html: text, bytes: bytes.length };
  if (kind.view === 'table') {
    const rows = csvRows(text);
    return { state: 'table', rows: rows.slice(0, MAX_ROWS + 1), total: rows.length, bytes: bytes.length };
  }
  return { state: 'text', text: text.slice(0, MAX_CHARS), total: text.length, bytes: bytes.length };
}

export function FileView({ src, file, size, maxWidth = 600, whole = false }: { src: string; file: string; size?: number; maxWidth?: number; whole?: boolean }) {
  const kind = fileKindOf(file);
  if (kind.view === 'pdf') return <Paper src={src} maxWidth={maxWidth} whole={whole} />;
  if (kind.view === 'image') return <ImageFile src={src} file={file} kind={kind} size={size} />;
  if (kind.view === 'none') return <NoPreview src={src} file={file} kind={kind} size={size} />;
  return <TextFile src={src} file={file} kind={kind} size={size} />;
}

function ImageFile({ src, file, kind, size }: { src: string; file: string; kind: FileKind; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <NoPreview src={src} file={file} kind={kind} size={size} />;
  return <img className="pg fimg" data-view="image" src={src} alt={file} onError={() => setFailed(true)} />;
}

function TextFile({ src, file, kind, size }: { src: string; file: string; kind: FileKind; size?: number }) {
  const [got, setGot] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setGot({ state: 'loading' });
    load(src, kind).then((l) => { if (live) setGot(l); }, () => { if (live) setGot({ state: 'failed' }); });
    return () => { live = false; };
  }, [src, kind.view]);

  if (got.state === 'loading') return <div className="pages"><div className="loading" /></div>;
  if (got.state === 'failed') return <NoPreview src={src} file={file} kind={kind} size={size} failed />;
  if (got.state === 'table') {
    const [head = [], ...body] = got.rows;
    const shown = Math.min(body.length, MAX_ROWS);
    return (
      <div className="pg fdoc" data-view="table">
        <div className="fscroll">
          <table className="ftable">
            <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
            <tbody>{body.slice(0, MAX_ROWS).map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
        {got.total - 1 > shown && <p className="fcut">{t('file.rowsCut', { shown, total: got.total - 1, limit: MAX_ROWS })}</p>}
      </div>
    );
  }
  if (got.state === 'text') {
    return (
      <div className="pg fdoc" data-view="text">
        <pre className="ftext">{got.text}</pre>
        {got.total > got.text.length && <p className="fcut">{t('file.textCut', { limit: MAX_CHARS.toLocaleString() })}</p>}
      </div>
    );
  }
  if (got.state === 'html') return <iframe className="pg fhtml" data-view="html" sandbox="" srcDoc={LOCKED + got.html} title={file} />;
  const m = got.mail;
  return (
    <div className="pg fdoc" data-view="mail">
      <dl className="fmail">
        {m.from && <><dt>{t('file.mail.from')}</dt><dd>{m.from}</dd></>}
        {m.to && <><dt>{t('file.mail.to')}</dt><dd>{m.to}</dd></>}
        {m.date && <><dt>{t('file.mail.date')}</dt><dd>{m.date}</dd></>}
        {m.subject && <><dt>{t('file.mail.subject')}</dt><dd><b>{m.subject}</b></dd></>}
      </dl>
      {m.text !== undefined ? <pre className="ftext">{m.text}</pre>
        : m.html !== undefined ? <iframe className="fhtml" sandbox="" srcDoc={LOCKED + m.html} title={m.subject ?? file} />
        : <p className="fcut">{t('file.mail.noBody')}</p>}
    </div>
  );
}

const sizeText = (n: number) => {
  const f = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${f.format(n / 1024)} KB` : `${f.format(n / 1024 / 1024)} MB`;
};

/** A type the app does not draw, or a file that could not be read: what it is, and its download. */
function NoPreview({ src, file, kind, size, failed = false }: { src: string; file: string; kind: FileKind; size?: number; failed?: boolean }) {
  const [bytes, setBytes] = useState(size);
  useEffect(() => {
    if (size !== undefined) { setBytes(size); return; }
    let live = true;
    fetch(src, { method: 'HEAD' }).then((r) => { const n = Number(r.headers.get('content-length')); if (live && r.ok && n > 0) setBytes(n); }, () => {});
    return () => { live = false; };
  }, [src, size]);
  return (
    <div className="pg fdoc fnone" data-view="none">
      <p>{t(failed ? 'file.unreadable' : 'file.noPreview')}</p>
      <dl className="fmail">
        <dt>{t('file.name')}</dt><dd className="mono">{file}</dd>
        <dt>{t('file.type')}</dt><dd className="mono">{kind.ext ? `${kind.ext.toUpperCase()} · ${kind.type}` : kind.type}</dd>
        {bytes !== undefined && <><dt>{t('file.size')}</dt><dd>{sizeText(bytes)}</dd></>}
      </dl>
      <a className="fdl" href={src} download={file} onClick={(e) => e.stopPropagation()}>{t('receipts.download')}</a>
    </div>
  );
}
