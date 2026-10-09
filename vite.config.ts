import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3456',
      '/scan': 'http://localhost:3456',
      '/books.json': 'http://localhost:3456',
      // The PDFs only: /receipts and /bank-statements alone are the app's own tab routes.
      '^/receipts/': 'http://localhost:3456',
      '^/bank-statements/': 'http://localhost:3456',
    },
  },
});
