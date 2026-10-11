/**
 * The colour test (Firma › Darstellung › Farbe (Test)): which accent the light theme uses while the
 * owner compares the brand red with the UI. tokens.css switches on <html data-palette>; index.html
 * applies the stored one before the first paint. To be removed or made final once the owner decides.
 */
export const PALETTES = ['blue', 'red', 'neutral'] as const;
export type Palette = typeof PALETTES[number];
