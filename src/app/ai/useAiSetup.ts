/**
 * This Mac's AI as a page shows it (docs/0.4.0/ai-setup.md): the view of GET /api/ai/setup and one
 * card per CLI, run by the state machine of src/platform/ai-setup.ts. While a card waits for the
 * person in Terminal the page looks every POLL_MS; it looks again when the window gets focus.
 * Nothing polls otherwise. A card that reaches a sign-in makes its one test call.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_MS, stepCards, waits, type AiSetupView, type CardEvent, type CardState, type Cards, type KeySaved, type SetupKey } from '../../platform/ai-setup.js';
import type { TerminalCli } from '../../platform/terminal.js';
import { language } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';

export interface AiSetup {
  view?: AiSetupView;
  cards: Cards;
  error?: string;
  install(cli: TerminalCli): Promise<void>;
  signIn(cli: TerminalCli): Promise<void>;
  again(cli: TerminalCli): void;
  saveKey(id: SetupKey, key: string | null): Promise<KeySaved>;
  choose(choice: { noAi?: boolean; askOther?: boolean }): Promise<void>;
}

export function useAiSetup(): AiSetup {
  const [view, setView] = useState<AiSetupView>();
  const [cards, setCards] = useState<Cards>({});
  const [error, setError] = useState<string>();
  const testing = useRef(new Set<TerminalCli>());

  const step = useCallback((cli: TerminalCli, event: CardEvent) => setCards((c) => stepCards(c, cli, event)), []);

  /** One look at a time: a look takes longer than the 2 s between polls, and an older answer must not overwrite a newer one. */
  const looking = useRef(false);
  const look = useCallback(async () => {
    if (looking.current) return;
    looking.current = true;
    try {
      const v = await api.aiSetup.view();
      setView(v);
      // A look that answers takes an earlier failure away.
      setError(undefined);
      const at = Date.now();
      for (const { cli, probe } of v.clis) step(cli, { kind: 'probed', probe, at });
    } catch (e) {
      setError(errorText(e));
    } finally {
      looking.current = false;
    }
  }, [step]);

  useEffect(() => { void look(); }, [look]);
  useEffect(() => {
    const focus = () => void look();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [look]);
  const waiting = Object.values(cards).some((c) => c && waits(c));
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void look(), POLL_MS);
    return () => clearInterval(id);
  }, [waiting, look]);
  useEffect(() => {
    for (const [cli, card] of Object.entries(cards) as Array<[TerminalCli, CardState]>) {
      if (card.kind !== 'testing' || testing.current.has(cli)) continue;
      testing.current.add(cli);
      api.aiSetup.test(cli)
        .then((result) => step(cli, { kind: 'tested', result }), (e) => step(cli, { kind: 'tested', result: { ok: false, why: 'other', said: errorText(e) } }))
        .finally(() => { testing.current.delete(cli); void look(); });
    }
  }, [cards, step, look]);

  const opening = (open: (cli: TerminalCli, language: string) => Promise<unknown>, kind: 'install' | 'signIn') => async (cli: TerminalCli) => {
    setError(undefined);
    try {
      await open(cli, language());
      step(cli, { kind, at: Date.now() });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return {
    view, cards, error,
    install: opening(api.aiSetup.install, 'install'),
    signIn: opening(api.aiSetup.signIn, 'signIn'),
    again: (cli) => { step(cli, { kind: 'again', at: Date.now() }); void look(); },
    saveKey: async (id, key) => {
      const saved = await api.aiSetup.key(id, key);
      setView(saved.view);
      return saved;
    },
    choose: async (choice) => {
      try { setView(await api.aiSetup.choose(choice)); } catch (e) { setError(errorText(e)); }
    },
  };
}
