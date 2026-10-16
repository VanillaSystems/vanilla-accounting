/**
 * A QR code as SVG, for the phone's pairing (Firma › Handy). The encoder is the one inside the
 * package that draws the invoice's payment part (Nayuki's qrcodegen, MIT); the package exports
 * only its own drawing, so the file is required beside the export it lies next to. Dark modules
 * on white: a code is paper, in both themes, as a scanner expects it.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

interface QrCode { size: number; getModule(x: number, y: number): boolean }
interface Qrcodegen { QrCode: { encodeText(text: string, ecl: unknown): QrCode; Ecc: { MEDIUM: unknown } } }

const require = createRequire(import.meta.url);
let gen: Qrcodegen | undefined;
const qrcodegen = (): Qrcodegen =>
  (gen ??= (require(join(dirname(require.resolve('swissqrbill/svg')), '..', 'shared', 'qr-code-generator.cjs')) as { qrcodegen: Qrcodegen }).qrcodegen);

export function qrSvg(text: string): string {
  const { QrCode } = qrcodegen();
  const code = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const quiet = 4;
  const n = code.size + 2 * quiet;
  let path = '';
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.getModule(x, y)) path += `M${x + quiet},${y + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
