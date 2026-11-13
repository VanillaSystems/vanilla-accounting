/**
 * «Einrichtung» before any books (docs/0.4.0/ai-setup.md, decision 1 as changed on 12.11.2026): the
 * books come first, the AI when it has work. The first screen says what the app is and asks what
 * the person wants: new books, existing ones, a move from another program, the demo. This Mac's AI
 * is looked at in the background (src/app/ai/useAiSetup.ts) and decides only what follows: with an
 * AI ready, new books start the setup conversation (src/app/onboarding/DraftConversation.tsx);
 * without one they open the form, and one line says what the AI would do and leads to setting it
 * up. That step is the conversation of design B, drawn by code: the CLI cards, then the one picked
 * or already on this Mac, the other offered quietly (src/app/ai/first-run.ts). «Ohne KI weiter»
 * there is remembered on this Mac and leads back to the choices.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FIRST_RUN_CLIS, planName, type CardState, type SetupKey } from '../../platform/ai-setup.js';
import { AI_CLIS, type TerminalCli } from '../../platform/terminal.js';
import type { DesktopInfo, FolderLook, HomeFolders } from '../../types/desktop.js';
import { language, t } from '../i18n/index.js';
import { api, errorText, sayAccess } from '../lib/api.js';
import { DEMO_HOME, desktop, macAsksForFolders } from '../desktop/bridge.js';
import { accessText } from '../desktop/access-text.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ICONS } from '../areas/icons.js';
import { CliCard, NoAccount } from './CliCard.js';
import { alreadyHere, legOf, otherOf, type Said } from './first-run.js';
import { KeyBlock } from './KeyBlock.js';
import { useAiSetup } from './useAiSetup.js';
import { useFollowEnd } from '../onboarding/follow-end.js';
import '../onboarding/onboarding.css';
import './ai-setup.css';

/** `name`, or `name 2`, `name 3`, … when a folder of that name is there already. */
export function freeName(name: string, taken: readonly string[]): string {
  let free = name;
  for (let n = 2; taken.includes(free); n++) free = `${name} ${n}`;
  return free;
}

const Ai = ({ children }: { children: ReactNode }) => <div className="msg ai obsay"><BotIcon /><div>{children}</div></div>;
const Me = ({ text, onChange }: { text: string; onChange?: () => void }) => (
  <div className="obme">{onChange ? <button type="button" className="linkbtn" onClick={onChange}>{t('onboarding.change')}</button> : null}<div className="msg me">{text}</div></div>
);
const Answers = ({ children }: { children: ReactNode }) => <div className="obind"><div className="qacts" role="group">{children}</div></div>;

/** `create`: the person chose new books already (the start page's «Neue Buchhaltung anlegen», the menu): that choice goes on by itself. */
export function FirstRun({ info, create, onSetup, onForm, onLeave }: { info: DesktopInfo | null; create?: boolean; onSetup(root: string): void; onForm(root?: string): void; onLeave(): void }) {
  const ai = useAiSetup();
  const view = ai.view;
  /** `home`: what the person wants; `ai`: setting up the AI, which she asked for. */
  const [stage, setStage] = useState<'home' | 'ai'>('home');
  const [said, setSaid] = useState<Said[]>([]);
  const [keyReady, setKeyReady] = useState<SetupKey>();
  // The CLI found on the first look stays the start, so a sign-in elsewhere does not move the conversation.
  const first = useRef<TerminalCli>(undefined);
  const turns = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useFollowEnd(turns, end);
  first.current ??= alreadyHere(ai.cards);
  const leg = legOf(said, first.current);
  const cli = leg?.cli;
  const card: CardState | undefined = cli ? ai.cards[cli] : undefined;
  const other = cli ? otherOf(cli) : undefined;
  const name = (c: TerminalCli) => t(`terminal.cli.${c}`);
  const push = (s: Said) => setSaid((was) => [...was, s]);
  /** «Ohne KI weiter» holds until she acts on an AI (installs, signs in, saves a key): looking at the cards and going back keeps it. */
  const wantsAi = () => { if (view?.noAi) void ai.choose({ noAi: false }); };
  const install = (c: TerminalCli) => { wantsAi(); push({ kind: 'install', cli: c }); void ai.install(c); };
  const signIn = (c: TerminalCli) => { wantsAi(); push({ kind: 'signIn', cli: c }); void ai.signIn(c); };
  const toHome = () => { setSaid([]); setStage('home'); };
  /** «Ohne KI weiter»: kept on this Mac (decision 6), and back to the choices. */
  const noAi = () => { void ai.choose({ noAi: true }); toHome(); };
  const setUp = () => setStage('ai');

  const looked = !!view && FIRST_RUN_CLIS.every((c) => ai.cards[c]);
  const readyCli = cli && card?.kind === 'ready' ? cli : FIRST_RUN_CLIS.find((c) => ai.cards[c]?.kind === 'ready');
  const readyCard = readyCli ? ai.cards[readyCli] : undefined;
  /** A key that serves the app's steps: saved just now, or kept on this Mac before. */
  const keyId = keyReady ?? (view?.available && !readyCli ? view.keys.find((k) => k.set)?.id : undefined);
  const done = !view?.off && (!!readyCli || !!keyId);
  /**
   * The look has its answer: one program is ready (another's test call may still run, up to a minute
   * and a half), or every program has answered, or the look failed. Until then «new books» waits.
   */
  const settled = done || (!view && !!ai.error) || (looked && !FIRST_RUN_CLIS.some((c) => ai.cards[c]?.kind === 'testing'));
  const wantsInstall = !!card && (card.kind === 'missing' || card.kind === 'silent' || card.kind === 'installing' || (card.kind === 'notFound' && card.waited === 'install'));
  const foundLine = !!card && leg?.by === 'install' && 'version' in card && !!card.version && (card.kind === 'signedOut' || card.kind === 'signingIn' || card.kind === 'testing'
    || card.kind === 'refused' || (card.kind === 'notFound' && card.waited === 'signIn') || card.kind === 'ready');
  const NoAiButton = <button type="button" className="btn" data-answer="no-ai" onClick={noAi}>{t('aiSetup.answer.noAi')}<small>{t('aiSetup.answer.noAiHint')}</small></button>;
  const installButton = (c: TerminalCli, primary: boolean) => view?.opens ? (
    <button key={c} type="button" className={primary ? 'btn primary' : 'btn'} data-answer={`install-${c}`} onClick={() => install(c)}>
      {t('aiSetup.answer.install', { cli: name(c) })}<small>{t('aiSetup.answer.installHint', { vendor: AI_CLIS[c].vendor, plan: AI_CLIS[c].minPlan })}</small>
    </button>
  ) : null;
  // The other CLI, offered quietly while the conversation follows one.
  const OtherButton = other && !done ? <button type="button" className="btn" data-answer={`switch-${other}`} onClick={() => push({ kind: 'switch', cli: other })}>{t('aiSetup.answer.switch', { cli: name(other) })}</button> : null;
  const pickText = (s: Said) => s.kind === 'install' ? t('aiSetup.answer.install', { cli: name(s.cli) }) : s.kind === 'switch' ? t('aiSetup.answer.switch', { cli: name(s.cli) }) : '';
  /** With one program ready, the other's card (what it needs, its command) has nothing to say here. */
  const shownCards = FIRST_RUN_CLIS.filter((c) => ai.cards[c] && !(readyCli && ai.cards[c]!.kind === 'missing'));
  const readyLine = !done ? null : readyCli && readyCard?.kind === 'ready' ? (
    <p className="okline" data-ready={readyCli}>{ICONS.check}{readyCard.plan
      ? t('aiSetup.say.ready', { cli: name(readyCli), plan: planName(readyCard.plan) })
      : t('aiSetup.say.readyNoPlan', { cli: name(readyCli) })}</p>
  ) : keyId ? <p className="okline" data-ready={keyId}>{ICONS.check}{t('aiSetup.say.keyReady', { provider: t(`aiSetup.key.${keyId}`) })}</p> : null;
  const ByHand = <button type="button" className="linkbtn" data-act="by-hand" onClick={() => onForm()}>{t('desktop.flow.byHand')}</button>;
  /**
   * Under the choices: the AI as this Mac has it, a fact and one way on. Nothing while the look runs,
   * nothing where it is switched off. A look that failed says so (the error line below) instead of
   * «none set up», and still leads to the AI step.
   */
  const aiFoot = !settled || view?.off ? null : done ? <>{readyLine}{ByHand}</> : (
    <p className="ailine" data-ai={view ? 'none' : 'unknown'}>
      {view ? <span>{t(view.noAi ? 'aiSetup.line.noAiKept' : 'aiSetup.line.none')}</span> : null}
      <button type="button" className="linkbtn" data-act="ai-setup" onClick={setUp}>{t('aiSetup.line.setUp')}</button>
    </p>
  );

  return (
    <div className="obflow" aria-label={t('onboarding.title')}>
      <header className="obflowhd">
        <span className="obwho">
          <span className="obface"><BotIcon /></span>
          <span><b>{t('onboarding.title')}</b><small>{t('onboarding.who')}</small></span>
        </span>
        <button type="button" className="linkbtn" data-act="first-leave" onClick={onLeave}>{t('aiSetup.toStart')}</button>
      </header>
      <div ref={turns} className="obflowturns">
        <Ai><p>{t('aiSetup.hello')}</p>{stage === 'home' ? <p>{t('aiSetup.what')}</p> : null}</Ai>
        {stage === 'home' ? <FolderStep info={info} ai={settled ? done : undefined} create={create} onSetup={onSetup} onForm={onForm} foot={aiFoot} /> : (
          <>
            <Me text={t('aiSetup.line.setUp')} onChange={toHome} />
            <Ai><p>{t('aiSetup.say.intro')}</p></Ai>
            {!view || !looked ? (ai.error ? null : <Ai><p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.looking')}</p></Ai>) : (
              <>
                {!leg || leg.by === 'already' ? (
                  <>
                    <div className="obind"><div className="obcard aiobcard">
                      {shownCards.map((c) => <CliCard key={c} cli={c} state={ai.cards[c]!} opens={view.opens} compact />)}
                    </div></div>
                    <div className="obind"><KeyBlock view={view} onSave={ai.saveKey} onKept={(id) => { wantsAi(); setKeyReady(id); }} /></div>
                    {!leg && !done ? <Answers>{FIRST_RUN_CLIS.map((c, i) => installButton(c, i === 0))}{NoAiButton}</Answers> : null}
                  </>
                ) : null}
                {said.slice(0, Math.max(leg?.at ?? 0, 0)).filter((s) => s.kind === 'install' || s.kind === 'switch').map((s, i) => <Me key={i} text={pickText(s)} />)}
                {leg && cli && card ? (
                  <>
                    {leg.by !== 'already' ? <Me text={pickText(said[leg.at])} onChange={() => setSaid(said.slice(0, leg.at))} /> : null}
                    {leg.by === 'install' ? <Ai><p>{t(view.opens ? 'aiSetup.say.terminalOpened' : 'aiSetup.say.copy', { vendor: AI_CLIS[cli].vendor })}</p></Ai> : null}
                    {leg.by === 'switch' && wantsInstall ? <Ai><p>{t('aiSetup.say.switchInstall', { cli: name(cli), vendor: AI_CLIS[cli].vendor })}</p></Ai> : null}
                    {wantsInstall && leg.by !== 'already' ? (
                      <div className="obind"><div className="obcard aiobcard"><CliCard cli={cli} state={card} opens={view.opens} compact actions={leg.by === 'install' && (card.kind === 'notFound' || card.kind === 'silent') ? { install: () => install(cli), signIn: () => signIn(cli), again: () => ai.again(cli) } : undefined} /></div></div>
                    ) : null}
                    {leg.by !== 'install' && wantsInstall && card.kind !== 'installing' && !done ? <Answers>{installButton(cli, true)}{OtherButton}{NoAiButton}</Answers> : null}
                    {leg.by === 'install' && (card.kind === 'installing' || card.kind === 'notFound') && !done ? <Answers>{card.kind === 'notFound' ? OtherButton : null}{NoAiButton}</Answers> : null}
                    {leg.by !== 'install' && !wantsInstall && 'version' in card && card.version ? (
                      <Ai><p>{t(card.kind === 'signedOut' || card.kind === 'signingIn' || card.kind === 'notFound' ? 'aiSetup.say.alreadyOut' : 'aiSetup.say.alreadyIn', { cli: name(cli), version: card.version })}</p>{card.kind === 'signedOut' ? <NoAccount cli={cli} /> : null}</Ai>
                    ) : null}
                    {foundLine && 'version' in card ? <Ai><p>{t('aiSetup.say.found', { cli: name(cli), version: card.version ?? '' })}</p>{card.kind === 'signedOut' ? <NoAccount cli={cli} /> : null}</Ai> : null}
                    {(card.kind === 'signedOut' || (card.kind === 'notFound' && card.waited === 'signIn')) && !leg.signIn && !done ? (
                      <Answers>
                        {view.opens ? <button type="button" className="btn primary" data-answer="sign-in" onClick={() => signIn(cli)}>{t('aiSetup.signIn')}<small>{t('aiSetup.answer.signInHint', { vendor: AI_CLIS[cli].vendor })}</small></button> : null}
                        {OtherButton}
                        {NoAiButton}
                      </Answers>
                    ) : null}
                    {leg.signIn ? (
                      <>
                        <Me text={t('aiSetup.signIn')} />
                        <Ai>
                          <p>{t('aiSetup.say.browser')}</p>
                          {card.kind === 'signingIn' ? <p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.signingIn.wait')}</p> : null}
                          {card.kind === 'notFound' ? <p className="warnline">{ICONS.warn}{t('aiSetup.notFound.signIn', { cli: name(cli) })}</p> : null}
                        </Ai>
                        {(card.kind === 'signingIn' || card.kind === 'notFound') && !done ? (
                          <Answers>
                            {card.kind === 'notFound' ? <button type="button" className="btn" onClick={() => ai.again(cli)}>{t('aiSetup.again')}</button> : null}
                            {card.kind === 'notFound' ? OtherButton : null}
                            {NoAiButton}
                          </Answers>
                        ) : null}
                      </>
                    ) : null}
                    {card.kind === 'testing' ? <Ai><p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.testing')}</p></Ai> : null}
                    {card.kind === 'refused' && !done ? (
                      <>
                        <Ai>
                          <p className="warnline">{ICONS.warn}{t(`aiSetup.refused.${card.why}`, { said: card.said })}</p>
                          <p>{card.why === 'plan' ? t('aiSetup.say.planNeeded', { cli: name(cli), plan: AI_CLIS[cli].minPlan, usd: AI_CLIS[cli].minPlanUsd }) : t('aiSetup.say.refusedWays')}</p>
                        </Ai>
                        <Answers>
                          <a className="btn" href={AI_CLIS[cli].plans} target="_blank" rel="noopener noreferrer">{t('aiSetup.plans', { vendor: AI_CLIS[cli].vendor })}{ICONS.external}</a>
                          {view.opens ? <button type="button" className="btn" onClick={() => signIn(cli)}>{t('aiSetup.otherAccount')}</button> : null}
                          <button type="button" className="btn" onClick={() => ai.again(cli)}>{t('aiSetup.again')}</button>
                          {OtherButton}
                          {NoAiButton}
                        </Answers>
                      </>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
            {done ? (
              <>
                <Ai>
                  {readyLine}
                  {readyCli ? FIRST_RUN_CLIS.filter((c) => c !== readyCli && ai.cards[c]?.kind !== 'ready').map((c) => <p key={c}>{t('aiSetup.say.otherLater', { cli: name(c) })}</p>) : null}
                </Ai>
                <FolderStep info={info} ai ask onSetup={onSetup} onForm={onForm} foot={ByHand} />
              </>
            ) : null}
          </>
        )}
        {ai.error ? <p className="warnline" role="alert">{ai.error}</p> : null}
        <div ref={end} className="obend" />
      </div>
    </div>
  );
}

/**
 * What the person wants, in plain choices: new books, books this app made, books from another
 * program (new books; the setup then asks for the old program and says what the move needs: nothing
 * is imported yet, and the answer says so),
 * or the demo first. `ai`: whether an AI answers on this Mac; undefined while the look still runs:
 * «new books» then waits for it, says so, and offers the form as the way on without waiting; the
 * other choices never wait. With an AI the system's save panel asks where the books go
 * and the setup conversation starts there; without one the form opens, which asks the same and
 * proposes the folder itself. `foot` stands under the choices; `ask` puts the question above them.
 * In the Mac app, before new books first go into the Documents folder, it says why macOS will now
 * ask about that folder and that «Erlauben» is needed, with another folder as the way out (#373);
 * the folder is read only on «Weiter», so macOS asks then, never over the first screen.
 */
function FolderStep({ info, ai, ask, create: chosenNew, foot, onSetup, onForm }: { info: DesktopInfo | null; ai: boolean | undefined; ask?: boolean; create?: boolean; foot?: ReactNode; onSetup(root: string): void; onForm(root?: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [chosen, setChosen] = useState('');
  /** The folder she named for new books, when it already holds something. */
  const [taken, setTaken] = useState<{ root: string; look: FolderLook }>();
  /** «New books» was clicked before the look at this Mac's AI had its answer. */
  // Chosen before this step showed: it runs as soon as the look at the AI has its answer (one click, issue #363).
  const [waiting, setWaiting] = useState(!!chosenNew);
  /** The Documents folder as read on «Weiter»: its folders (for a free name) and macOS's answer. */
  const [home, setHome] = useState<HomeFolders>();
  /** New books wait for her word on macOS's question: `ask` before it, `refused` after «Nicht erlauben», `locked` when the folder's own rights refuse. */
  const [access, setAccess] = useState<'ask' | 'refused' | 'locked'>();
  const known = home?.access ?? info?.homeAccess;
  const name = freeName(t('desktop.folderName', { year: String(new Date().getFullYear()) }), home?.folders ?? info?.folders ?? []);
  const run = async (go: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await go(); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  /** A dialog of the desktop app; one that fails says so in the step's error line, and gives nothing. */
  const asked = async (dialog: Promise<string | null> | undefined): Promise<string | null> => {
    setError('');
    try { return (await dialog) ?? null; } catch (e) { setError(errorText(e)); return null; }
  };
  const create = async () => {
    if (ai === undefined) { setWaiting(true); return; }
    // The Mac app reads the Documents folder only now, once she knows why macOS asks.
    if (macAsksForFolders && known !== 'allowed') { setAccess(known === 'refused' ? 'refused' : 'ask'); return; }
    // Allowed already (or no Mac): the folder is read without a word, for a name not taken (#373 review).
    await allow();
  };
  /** «Weiter»: the Documents folder is read now, and macOS asks her over these words. */
  const allow = () => run(async () => {
    const read = await api.desktop.folders();
    setHome(read);
    setBusy(false);
    if (read.access !== 'allowed') { setAccess(read.access); return; }
    setAccess(undefined);
    await createIn(freeName(t('desktop.folderName', { year: String(new Date().getFullYear()) }), read.folders));
  });
  /** New books in the Documents folder (`elsewhere`: in a folder she picks, Documents left alone). */
  const createIn = async (free: string, elsewhere = false) => {
    if (!ai) {
      if (!elsewhere) { onForm(); return; }
      const dir = await asked(desktop?.chooseFolder(t('desktop.chooseNew'), 'home'));
      if (dir) onForm(dir);
      return;
    }
    const root = desktop
      ? await asked(desktop.chooseNewFolder({ title: t('aiSetup.folder.createTitle'), name: free, button: t('aiSetup.folder.createButton'), ...(elsewhere ? { elsewhere } : {}) }))
      : info ? `${info.booksHome}/${free}` : null;
    if (!root) return;
    setTaken(undefined);
    setChosen(root);
    await run(async () => {
      // A folder that is not new (the save panel lets her pick one): said, never continued in silently.
      const look = desktop ? await api.desktop.folder(root) : undefined;
      if (look && look.holds !== 'nothing') { setTaken({ root, look }); setChosen(''); setBusy(false); return; }
      const begun = await api.desktop.setupBegin(root, language());
      if (begun.kind === 'books') location.assign('/');
      else onSetup(begun.view.root);
    });
  };
  const openTaken = (dir: string) => run(async () => { const books = await api.desktop.open(dir); if (books.setup) onSetup(books.root); else location.assign('/'); });
  const going = useRef(create);
  going.current = create;
  useEffect(() => {
    if (!waiting || ai === undefined) return;
    setWaiting(false);
    void going.current();
  }, [waiting, ai]);
  const open = async () => {
    const dir = await asked(desktop?.chooseFolder(t('desktop.chooseOpen')));
    if (dir) await run(async () => { const books = await api.desktop.open(dir); if (books.setup) onSetup(books.root); else location.assign('/'); });
  };
  const demo = () => run(async () => { await api.desktop.demo(); location.assign(DEMO_HOME); });
  return (
    <div className="obstep" data-step="folder">
      {ask ? <Ai><p>{t('aiSetup.folder.ask')}</p></Ai> : null}
      <Answers>
        <button type="button" className="btn primary" data-answer="create" disabled={busy || waiting} onClick={() => void create()}>{t('aiSetup.folder.create')}<small>{t('aiSetup.folder.createHint')}</small></button>
        {desktop ? <button type="button" className="btn" data-answer="open" disabled={busy} onClick={() => void open()}>{t('aiSetup.folder.open')}<small>{t('aiSetup.folder.openHint')}</small></button> : null}
        <button type="button" className="btn" data-answer="switch" disabled={busy} onClick={() => setSwitching(true)}>{t('aiSetup.folder.switch')}<small>{t('aiSetup.folder.switchHint')}</small></button>
        <button type="button" className="btn" data-answer="demo" disabled={busy} onClick={() => void demo()}>{t('aiSetup.folder.demo')}<small>{t('aiSetup.folder.demoHint')}</small></button>
      </Answers>
      {switching ? (
        <>
          <Me text={t('aiSetup.folder.switch')} />
          <Ai><p>{t('aiSetup.folder.switchSay')}</p></Ai>
          <Answers><button type="button" className="btn primary" data-answer="create-switch" disabled={busy || waiting} onClick={() => void create()}>{t('aiSetup.folder.create')}<small>{t('aiSetup.folder.createHint')}</small></button></Answers>
        </>
      ) : null}
      {waiting ? (
        <div data-waiting="ai">
          <Ai><p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.checking')}</p></Ai>
          <Answers><button type="button" className="btn" data-act="by-hand" onClick={() => { setWaiting(false); onForm(); }}>{t('desktop.flow.byHand')}<small>{t('aiSetup.checkingSkip')}</small></button></Answers>
        </div>
      ) : null}
      {access ? (
        <div data-access={access}>
          <Me text={t('aiSetup.folder.create')} />
          <Ai>
            {access === 'ask' ? <><p>{t('aiSetup.folder.access')}</p><p>{t('aiSetup.folder.accessNo')}</p></>
              : <p className="warnline" role="alert">{access === 'locked' ? accessText(sayAccess, { folder: 'documents', why: 'rights' }, info?.booksHome ?? '') : t('aiSetup.folder.accessRefused')}</p>}
          </Ai>
          <Answers>
            <button type="button" className="btn primary" data-answer={access === 'ask' ? 'allow' : 'again'} disabled={busy} onClick={() => void allow()}>
              {t(access === 'ask' ? 'aiSetup.folder.accessGo' : 'aiSetup.folder.accessAgain')}{access === 'ask' ? <small>{t('aiSetup.folder.accessGoHint')}</small> : null}
            </button>
            <button type="button" className="btn" data-answer="elsewhere" disabled={busy} onClick={() => { setAccess(undefined); void createIn(name, true); }}>{t('aiSetup.folder.elsewhere')}<small>{t('aiSetup.folder.elsewhereHint')}</small></button>
          </Answers>
        </div>
      ) : null}
      {chosen ? <Ai><p>{t('aiSetup.folder.chosen')}</p><p className="obfolder mono">{chosen}</p></Ai> : null}
      {taken ? (
        <div data-taken={taken.look.holds}>
          <p className="warnline" role="alert">{taken.look.holds === 'books' ? t('aiSetup.folder.takenBooks', { name: taken.look.name ?? '' }) : t(taken.look.holds === 'setup' ? 'aiSetup.folder.takenSetup' : 'aiSetup.folder.takenFiles')}</p>
          <p className="obfolder mono">{taken.root}</p>
          {taken.look.holds === 'files' ? null : (
            <Answers><button type="button" className="btn" data-answer="open-taken" disabled={busy} onClick={() => void openTaken(taken.root)}>{t(taken.look.holds === 'books' ? 'aiSetup.folder.takenOpen' : 'aiSetup.folder.takenContinue')}</button></Answers>
          )}
        </div>
      ) : null}
      {foot ? <div className="obind">{foot}</div> : null}
      {error ? <p className="warnline" role="alert">{error}</p> : null}
    </div>
  );
}
