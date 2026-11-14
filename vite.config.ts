import { realpathSync } from 'fs';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, sep } from 'path';
import { devProxy } from './src/server/app-paths';

// Agents' worktrees and scratch output live inside the checkout: their HTML and tsconfig.json
// files must neither enter the dep scan nor reload, clear the cache or re-optimise this server.
// Anchored at this checkout, since a worktree's own root lies under .claude/ too.
const scratch = ['.claude', '.verify', '.gstack', 'out', 'release'].map((dir) => resolve(__dirname, dir));
const isScratch = (path: string) => scratch.some((dir) => path === dir || path.startsWith(dir + sep));

export default defineConfig(({ mode }) => ({
  // The static audit export and the public demo (npm run build:audit [--demo]) run under any base path: every URL is relative.
  base: mode === 'audit' || mode === 'demo' ? './' : '/',
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
    // A worktree's node_modules is often a link to the main checkout's, outside this root: without
    // its target on the allow list the bundled fonts answer 403 and the app shows its fallback fonts.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(resolve(__dirname, 'node_modules'))],
    },
    watch: {
      ignored: isScratch,
    },
  },
}));
