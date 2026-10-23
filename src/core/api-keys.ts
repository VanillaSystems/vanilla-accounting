/**
 * The shape of an AI provider's API key (issue #48). A key belongs to this computer's secret
 * store: the public app files (src/publish/leak-guard.ts) and a workspace's commits
 * (src/workspace/git.ts) refuse a text that holds one.
 */
const API_KEY = /(?<![A-Za-z0-9_-])sk-(?:ant-[A-Za-z0-9_-]{20,}|(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,})/g;

/** The keys a text holds, each shortened to its first characters so a report never repeats it. */
export function apiKeysIn(text: string): Array<{ index: number; shown: string }> {
  return [...text.matchAll(API_KEY)].map((m) => ({ index: m.index!, shown: `${m[0].slice(0, 10)}…` }));
}
