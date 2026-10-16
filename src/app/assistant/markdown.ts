/**
 * The small part of Markdown an answer of the AI sidebar uses, as data the sidebar renders with
 * React elements (never as HTML, so nothing in an answer is markup): paragraphs, line breaks, bold
 * (**…**, a heading line as bold), and lists with - , * or 1. Anything else stays as written. Pure,
 * so a test reads it without a browser.
 */

/** A run of text, bold or not. */
export interface Span { text: string; bold?: true }

/** A paragraph's lines, or a list's items, each a line of spans. */
export type Block =
  | { kind: 'p'; lines: Span[][] }
  | { kind: 'ul' | 'ol'; items: Span[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

/** The spans of one line: text between a pair of ** is bold; a ** without its pair stays as written. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  const parts = line.split('**');
  const paired = parts.length % 2 === 1 ? parts : [...parts.slice(0, -2), `${parts.at(-2)}**${parts.at(-1)}`];
  paired.forEach((text, i) => {
    if (!text) return;
    const bold = i % 2 === 1;
    const last = out.at(-1);
    if (last && !!last.bold === bold) last.text += text;
    else out.push(bold ? { text, bold: true } : { text });
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
