import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, sep } from 'path';
import { devProxy } from './src/server/app-paths';

// Agents' worktrees and scratch output live inside the checkout: their HTML and tsconfig.json
// files must neither enter the dep scan nor reload, clear the cache or re-optimise this server.
// Anchored at this checkout, since a worktree's own root lies under .claude/ too.
const scratch = ['.claude', '.verify', '.gstack', 'out', 'release'].map((dir) => resolve(__dirname, dir));
const isScratch = (path: string) => scratch.some((dir) => path === dir || path.startsWith(dir + sep));

export default defineConfig(({ mode }) => ({
  // The static audit export (npm run build:audit) runs under any base path: every URL is relative.
  base: mode === 'audit' ? './' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    proxy: devProxy('http://localhost:3456'),
    watch: {
      ignored: isScratch,
    },
  },
}));
