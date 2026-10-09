/** The workspace's files the UI reads directly, served by the API (Vite proxies them in dev). */
import express, { Router } from 'express';
import { WS } from './books.js';

export const router = Router();

router.get('/books.json', (_req, res) => {
  res.sendFile(WS.paths.books);
});
router.use('/receipts', express.static(WS.paths.receipts));
router.use('/bank-statements', express.static(WS.paths.statements));
