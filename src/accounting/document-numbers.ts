/** A text with its spaces, dashes and slashes taken out, upper case: «FM-79010» and «fm 79010» compare equal. */
export const squash = (s: string) => s.toUpperCase().replace(/[\s\-/]/g, '');

/** Invoice, order and customer numbers in a text («FM-79010», «RE-4471», «2026-031»): no dates, amounts or postcodes; squashed. */
export function numbersIn(text: string): string[] {
  const tokens = text.split(/[\s,;:()[\]«»"']+/).map((x) => x.replace(/^[-/#]+|[-/#.]+$/g, ''));
  return [...new Set(tokens.filter((x) => !x.includes('.') && /\d/.test(x) && (/[A-Za-z\-/]/.test(x) || x.length >= 5)).map(squash).filter((x) => x.length >= 5))];
}
