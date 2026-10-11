/**
 * POST /api/export: the export dialog's bundle (src/export/bundle.ts) as a download, a ZIP or the
 * one file chosen. It only reads the books, so it answers in audit mode too (READONLY=1).
 */
import { Router } from 'express';
import { buildBundle, downloadOf, zipBundle } from '../../export/bundle.js';
import { BadRequest, parseRequest } from '../../export/model.js';
import { NoBrowserError, printPdf } from '../../invoices/pdf.js';
import { accountsOf } from '../../workspace/reads.js';
import { RequestError, WS, readBooks } from '../books.js';

export const router = Router();

router.post('/api/export', async (req, res) => {
  let request;
  try { request = parseRequest(req.body); } catch (e) {
    if (e instanceof BadRequest) throw new RequestError(400, e.message);
    throw e;
  }
  const names = Object.fromEntries((accountsOf(WS) as Array<{ number: string; name: string }>).map((a) => [a.number, a.name]));
  const bundle = await buildBundle(WS, readBooks(), names, request, { print: printPdf }).catch((e: unknown) => {
    throw e instanceof NoBrowserError ? new RequestError(503, e.message, { code: 'noBrowser' }) : e;
  });
  const { name, type } = downloadOf(bundle);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (bundle.files.length === 1) { res.end(Buffer.from(bundle.files[0].data)); return; }
  await zipBundle(bundle, (chunk) => res.write(chunk));
  res.end();
});
