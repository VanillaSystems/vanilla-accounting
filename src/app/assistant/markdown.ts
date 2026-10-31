/**
 * The small part of Markdown an answer of the AI sidebar uses, as data the sidebar renders with
 * React elements (never as HTML, so nothing in an answer is markup): paragraphs, line breaks, bold
 * (**…**, a heading line as bold), lists with - , * or 1., and web links (a bare https:// address or
 * [text](https://…); no other scheme). Anything else stays as written. Pure,
 * so a test reads it without a browser.
 */

/** A run of text, bold or not, a link when it has `href`. */
export interface Span { text: string; bold?: true; href?: string }

/** A paragraph's lines, or a list's items, each a line of spans. */
export type Block =
  | { kind: 'p'; lines: Span[][] }
  | { kind: 'ul' | 'ol'; items: Span[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>«»"]+/g;

/** A bare address ends before the punctuation that closes its sentence, and before a ")" it did not open. */
function trimmed(url: string): string {
  let u = url.replace(/[.,;:!?'"\]]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1).replace(/[.,;:!?'"\]]+$/, '');
  return u;
}

/** The links in a run of text: web addresses only, so an answer can never link to a script or a file. */
function linked(text: string, bold: boolean): Span[] {
  const out: Span[] = [];
  const plain = (t: string) => { if (t) out.push(bold ? { text: t, bold: true } : { text: t }); };
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const href = m[2] ?? trimmed(m[0]);
    const whole = m[2] ? m[0] : href;
    plain(text.slice(at, m.index));
    out.push({ text: m[1] ?? href, href, ...(bold ? { bold: true as const } : {}) });
    at = m.index + whole.length;
  }
  plain(text.slice(at));
  return out;
}

/** The spans of one line: text between a pair of ** is bold; a ** without its pair stays as written. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  const parts = line.split('**');
  const paired = parts.length % 2 === 1 ? parts : [...parts.slice(0, -2), `${parts.at(-2)}**${parts.at(-1)}`];
  paired.forEach((text, i) => {
    if (!text) return;
    const bold = i % 2 === 1;
    for (const span of linked(text, bold)) {
      const last = out.at(-1);
      if (last && !last.href && !span.href && !!last.bold === bold) last.text += span.text;
      else out.push(span);
    }
  });
  return out;
}

export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const last = blocks.at(-1);
    if (!line.trim()) { blocks.push({ kind: 'p', lines: [] }); continue; }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (item) {
      const kind = BULLET.test(line) ? 'ul' : 'ol';
      if (last?.kind === kind) last.items.push(spans(item[1]));
      else blocks.push({ kind, items: [spans(item[1])] });
      continue;
    }
    const heading = HEADING.exec(line);
    const lineSpans = heading ? [{ text: heading[1].replace(/\*\*/g, ''), bold: true as const }] : spans(line);
    if (last?.kind === 'p') last.lines.push(lineSpans);
    else blocks.push({ kind: 'p', lines: [lineSpans] });
  }
  return blocks.filter((b) => (b.kind === 'p' ? b.lines.length : b.items.length));
}
