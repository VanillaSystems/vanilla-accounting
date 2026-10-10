import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { devProxy } from './src/server/app-paths';

export default defineConfig(({ mode }) => ({
  // The static audit export (npm run build:audit) runs under any base path: every URL is relative.
  base: mode === 'audit' ? './' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: devProxy('http://localhost:3456'),
  },
}));
