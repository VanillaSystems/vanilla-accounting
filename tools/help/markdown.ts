/**
 * The part of Markdown the help pages are written in, as HTML: headings (#, ##, ###), paragraphs,
 * lists (- and 1.), tables (| a | b | over |---|---|), a note (> …), **bold**, `code` and
 * [links](target). A link to another page names its slug ([Das Quartal](quartal)) and becomes
 * `quartal.html`; a link with a scheme or a # stays as written. Every text is escaped, so a page
 * source holds no markup of its own. Anything else stays as written.
 */

export const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A page link: a bare slug, maybe with an anchor, gets `.html`; a URL, an anchor or a file stays. */
export function href(target: string): string {
  const m = /^([a-z0-9-]+)(#.*)?$/.exec(target);
  return m ? `${m[1]}.html${m[2] ?? ''}` : target;
}

/** One line of text: escaped, with bold, code and links. */
export function inline(text: string): string {
  const out: string[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    out.push(escape(text.slice(at, m.index)));
    if (m[1] !== undefined) out.push(`<code>${escape(m[1])}</code>`);
    else if (m[2] !== undefined) out.push(`<strong>${inline(m[2])}</strong>`);
    else out.push(`<a href="${escape(href(m[4]))}">${inline(m[3])}</a>`);
    at = m.index + m[0].length;
  }
  out.push(escape(text.slice(at)));
  return out.join('');
}

/** A heading's anchor: lowercase words joined by "-", umlauts kept as their base letter plus e. */
export const anchor = (text: string): string =>
  text.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** `raw` lines (a generated block's HTML) pass through as they are. */
export function markdown(source: string, raw: (line: string) => string | undefined = () => undefined): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  const take = (test: (l: string) => boolean): string[] => {
    const run: string[] = [];
    while (i < lines.length && test(lines[i])) run.push(lines[i++]);
    return run;
  };
  while (i < lines.length) {
    const line = lines[i];
    const block = raw(line);
    if (block !== undefined) { html.push(block); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level} id="${anchor(heading[2])}">${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html.push(`<ul>${take((l) => /^\s*[-*]\s+/.test(l)).map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      html.push(`<ol>${take((l) => /^\s*\d+\.\s+/.test(l)).map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`);
      continue;
    }
    if (line.startsWith('>')) {
      html.push(`<aside class="note"><p>${take((l) => l.startsWith('>')).map((l) => inline(l.replace(/^>\s?/, ''))).join(' ')}</p></aside>`);
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const [head, , ...body] = take((l) => l.trim().startsWith('|'));
      html.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const para = [lines[i++], ...take((l) => !!l.trim() && raw(l) === undefined && !/^(#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|>|\s*\|)/.test(l))];
    html.push(`<p>${para.map(inline).join(' ')}</p>`);
  }
  return html.join('\n');
}
