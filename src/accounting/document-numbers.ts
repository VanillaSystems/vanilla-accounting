/** A text with its spaces, dashes and slashes taken out, upper case: «FM-79010» and «fm 79010» compare equal. */
export const squash = (s: string) => s.toUpperCase().replace(/[\s\-/]/g, '');

/** The words of a text as a number is cut out of it: split at spaces and punctuation, leading and trailing dashes, slashes, «#» and dots taken off. */
const tokens = (text: string): string[] => text.split(/[\s,;:()[\]«»"']+/).map((x) => x.replace(/^[-/#]+|[-/#.]+$/g, ''));

/** Invoice, order and customer numbers in a text («FM-79010», «RE-4471», «2026-031»): no dates, amounts or postcodes; squashed. */
export function numbersIn(text: string): string[] {
  return [...new Set(tokens(text).filter((x) => !x.includes('.') && /\d/.test(x) && (/[A-Za-z\-/]/.test(x) || x.length >= 5)).map(squash).filter((x) => x.length >= 5))];
}

/** Every word of a text, squashed: a number of numbersIn stands in the text as a whole token when it is one of them («2026-029» in «Rechnung 2026-029», not in «2026-0291»). */
export const tokensIn = (text: string): Set<string> => new Set(tokens(text).filter(Boolean).map(squash));
