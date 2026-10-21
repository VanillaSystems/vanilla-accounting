/**
 * The names of Wissen's pages (docs/urls.md /knowledge/<topic>), browser-safe: the URL parser and
 * the notes files share them. A topic's slug is lowercase; Wissen's own pages keep theirs.
 */
export const KNOWLEDGE_PAGES = ['gaps', 'app'] as const;
export type KnowledgePage = typeof KNOWLEDGE_PAGES[number];

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const isTopicSlug = (s: unknown): s is string => typeof s === 'string' && SLUG.test(s) && !(KNOWLEDGE_PAGES as readonly string[]).includes(s);
