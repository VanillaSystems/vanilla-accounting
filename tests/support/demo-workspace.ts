/**
 * Imported first by a test whose imports open the workspace of the process (src/server/books.ts):
 * without a .env (a fresh worktree) it is the bundled demo, so the file runs on its own.
 */
process.env.VANILLA_WORKSPACE ||= 'demo';
