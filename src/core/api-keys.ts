/**
 * The shape of an AI provider's API key (issue #48). A key belongs to this computer's secret
 * store: the public app files (src/publish/leak-guard.ts) and a workspace's commits
 * (src/workspace/git.ts) refuse a text that holds one.
 */
// sk-ant- is Anthropic's own prefix, found inside any word; the bare sk- of OpenAI only where a word starts, so task-<uuid> is no key.
const API_KEY = /sk-ant-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g;

/** The keys a text holds, each shortened to its first characters so a report never repeats it. */
export function apiKeysIn(text: string): Array<{ index: number; shown: string }> {
  return [...text.matchAll(API_KEY)].map((m) => ({ index: m.index!, shown: `${m[0].slice(0, 10)}…` }));
}
