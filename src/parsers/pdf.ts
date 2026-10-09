import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export async function extractText(
  pdfPath: string,
): Promise<{ text: string; method: 'pdftotext' | 'tesseract'; imagePath?: string }> {
  // Try pdftotext first (fast, works for computer-generated PDFs)
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-enc', 'UTF-8', pdfPath, '-']);
    const text = stdout.trim();
    if (text.length > 30) {
      return { text, method: 'pdftotext' };
    }
  } catch {
    // fall through
  }

  // Fallback: convert to image for further processing (tesseract or Claude vision)
  const imagePath = await pdfToImage(pdfPath);
  if (!imagePath) return { text: '', method: 'tesseract' };

  try {
    const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '-l', 'deu+eng']);
    const text = stdout.trim();
    if (text.length > 0) {
      unlinkSync(imagePath);
      return { text, method: 'tesseract' };
    }
  } catch {
    // tesseract failed or returned empty — fall through to Claude vision
  }

  // Return the image path so the caller (extract.ts) can send it to Claude vision
  return { text: '', method: 'tesseract', imagePath };
}

/**
 * Convert the first page of a PDF to a PNG.
 * Returns the temp image path, or null on failure.
 */
export async function pdfToImage(pdfPath: string): Promise<string | null> {
  const tmpBase = join(tmpdir(), `belaege-${Date.now()}`);
  try {
    await execFileAsync('pdftoppm', ['-r', '300', '-l', '1', '-png', pdfPath, tmpBase]);
    // pdftoppm pads the number: single-page → -1.png, multi-page → -01.png etc.
    for (const candidate of [`${tmpBase}-1.png`, `${tmpBase}-01.png`, `${tmpBase}-001.png`]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
