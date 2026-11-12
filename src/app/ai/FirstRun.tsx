/**
 * «Einrichtung» before any books (docs/0.4.0/ai-setup.md, design B): the conversation opens with the
 * AI, then asks for the folder. Every step is drawn by code from this Mac's AI setup
 * (src/app/ai/useAiSetup.ts), so it works before any AI exists: the answers are buttons. Both CLI
 * cards stand in the first message; the conversation then follows the one picked, or the one
 * already on this Mac, and offers the other quietly (src/app/ai/first-run.ts). Once a CLI
 * or a key is ready, or the person goes on without AI (remembered on this Mac), it asks where the
 * books go; «Dieser Ordner passt» starts the setup conversation there (src/app/onboarding/DraftConversation.tsx).
 */
import { useRef, useState, type ReactNode } from 'react';
import { FIRST_RUN_CLIS, planName, type CardState, type SetupKey } from '../../platform/ai-setup.js';
import { AI_CLIS, type TerminalCli } from '../../platform/terminal.js';
import type { DesktopInfo, FolderLook } from '../../types/desktop.js';
import { language, t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { desktop } from '../desktop/bridge.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ICONS } from '../areas/icons.js';
import { CliCard } from './CliCard.js';
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

export function FirstRun({ info, onSetup, onForm, onLeave }: { info: DesktopInfo | null; onSetup(root: string): void; onForm(): void; onLeave(): void }) {
  const ai = useAiSetup();
  const view = ai.view;
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
  const install = (c: TerminalCli) => { push({ kind: 'install', cli: c }); void ai.install(c); };
  const signIn = (c: TerminalCli) => { push({ kind: 'signIn', cli: c }); void ai.signIn(c); };
  const noAi = () => { push({ kind: 'noAi' }); void ai.choose({ noAi: true }); };
  const takeBackNoAi = () => { setSaid((s) => s.filter((x) => x.kind !== 'noAi')); void ai.choose({ noAi: false }); };

  const chosenNoAi = said.some((s) => s.kind === 'noAi');
  const readyCli = cli && card?.kind === 'ready' ? cli : FIRST_RUN_CLIS.find((c) => ai.cards[c]?.kind === 'ready');
  const readyCard = readyCli ? ai.cards[readyCli] : undefined;
  const keptNoAi = !!view?.noAi && !chosenNoAi && !readyCli;
  const done = !!readyCli || !!keyReady || chosenNoAi || keptNoAi;
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
        <Ai><p>{t(keptNoAi ? 'aiSetup.helloNoAi' : 'aiSetup.hello')}</p></Ai>
        {!view || !FIRST_RUN_CLIS.some((c) => ai.cards[c]) ? (ai.error ? <p className="warnline" role="alert">{ai.error}</p> : <Ai><p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.looking')}</p></Ai>) : keptNoAi ? null : (
          <>
            {!leg || leg.by === 'already' ? (
              <>
                <div className="obind"><div className="obcard aiobcard">
                  {FIRST_RUN_CLIS.map((c) => ai.cards[c] && <CliCard key={c} cli={c} state={ai.cards[c]!} opens={view.opens} compact />)}
                </div></div>
                <div className="obind"><KeyBlock view={view} onSave={ai.saveKey} onKept={setKeyReady} /></div>
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
                {leg.by === 'install' && card.kind === 'notFound' && !done ? <Answers>{OtherButton}{NoAiButton}</Answers> : null}
                {leg.by !== 'install' && !wantsInstall && 'version' in card && card.version ? (
                  <Ai><p>{t(card.kind === 'signedOut' || card.kind === 'signingIn' || card.kind === 'notFound' ? 'aiSetup.say.alreadyOut' : 'aiSetup.say.alreadyIn', { cli: name(cli), version: card.version })}</p></Ai>
                ) : null}
                {foundLine && 'version' in card ? <Ai><p>{t('aiSetup.say.found', { cli: name(cli), version: card.version ?? '' })}</p></Ai> : null}
                {(card.kind === 'signedOut' || (card.kind === 'notFound' && card.waited === 'signIn')) && !leg.signIn && !done ? (
                  <Answers>
                    {view.opens ? <button type="button" className="btn primary" data-answer="sign-in" onClick={() => signIn(cli)}>{t('aiSetup.signIn')}<small>{t('aiSetup.answer.signInHint', { command: `${AI_CLIS[cli].program} ${AI_CLIS[cli].login.join(' ')}` })}</small></button> : null}
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
                    {card.kind === 'notFound' && !done ? <Answers><button type="button" className="btn" onClick={() => ai.again(cli)}>{t('aiSetup.again')}</button>{OtherButton}{NoAiButton}</Answers> : null}
                  </>
                ) : null}
                {card.kind === 'testing' ? <Ai><p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.testing')}</p></Ai> : null}
                {card.kind === 'refused' && !done ? (
                  <>
                    <Ai>
                      <p className="warnline">{ICONS.warn}{t(`aiSetup.refused.${card.why}`, { said: card.said })}</p>
                      <p>{card.why === 'plan' ? t('aiSetup.say.planNeeded', { cli: name(cli), plan: AI_CLIS[cli].minPlan }) : t('aiSetup.say.refusedWays')}</p>
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
        {readyCli && readyCard?.kind === 'ready' ? (
          <Ai>
            <p className="okline" data-ready={readyCli}>{ICONS.check}{readyCard.plan
              ? t('aiSetup.say.ready', { cli: name(readyCli), plan: planName(readyCard.plan) })
              : t('aiSetup.say.readyNoPlan', { cli: name(readyCli) })}</p>
            {FIRST_RUN_CLIS.filter((c) => c !== readyCli && ai.cards[c]?.kind !== 'ready').map((c) => <p key={c}>{t('aiSetup.say.otherLater', { cli: name(c) })}</p>)}
          </Ai>
        ) : null}
        {keyReady && !readyCli ? <Ai><p className="okline" data-ready={keyReady}>{ICONS.check}{t('aiSetup.say.keyReady', { provider: t(`aiSetup.key.${keyReady}`) })}</p></Ai> : null}
        {chosenNoAi ? (
          <>
            <Me text={t('aiSetup.answer.noAi')} onChange={takeBackNoAi} />
            <Ai><p>{t('aiSetup.say.noAi')}</p></Ai>
          </>
        ) : null}
        {done ? <FolderStep info={info} onSetup={onSetup} onForm={onForm} /> : null}
        {ai.error && view ? <p className="warnline" role="alert">{ai.error}</p> : null}
        <div ref={end} className="obend" />
      </div>
      <div className="obtalk">
        <div className="obtalkbox">
          <textarea name="talk" rows={2} disabled placeholder={t(done ? 'aiSetup.talkAfterFolder' : 'aiSetup.talkWaits')} aria-label={t('onboarding.talk.label')} />
          <button type="button" className="aisend" aria-label={t('assistant.send')} disabled>{ICONS.arrowUp}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * What comes after the AI, in plain choices: new books created where the person saves them (the
 * system's save panel opens at once, the name prefilled in Documents), books this app made, books
 * from another program (new books; the setup conversation then asks for the old program and takes
 * its journal as examples), or the demo first.
 */
function FolderStep({ info, onSetup, onForm }: { info: DesktopInfo | null; onSetup(root: string): void; onForm(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [chosen, setChosen] = useState('');
  /** The folder she named for new books, when it already holds something. */
  const [taken, setTaken] = useState<{ root: string; look: FolderLook }>();
  const name = freeName(t('desktop.folderName', { year: String(new Date().getFullYear()) }), info?.folders ?? []);
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
    const root = desktop
      ? await asked(desktop.chooseNewFolder({ title: t('aiSetup.folder.createTitle'), name, button: t('aiSetup.folder.createButton') }))
      : info ? `${info.booksHome}/${name}` : null;
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
  const open = async () => {
    const dir = await asked(desktop?.chooseFolder(t('desktop.chooseOpen')));
    if (dir) await run(async () => { const books = await api.desktop.open(dir); if (books.setup) onSetup(books.root); else location.assign('/'); });
  };
  const demo = () => run(async () => { await api.desktop.demo(); location.assign('/'); });
  return (
    <div className="obstep" data-step="folder">
      <Ai><p>{t('aiSetup.folder.ask')}</p></Ai>
      <Answers>
        <button type="button" className="btn primary" data-answer="create" disabled={busy} onClick={() => void create()}>{t('aiSetup.folder.create')}<small>{t('aiSetup.folder.createHint')}</small></button>
        {desktop ? <button type="button" className="btn" data-answer="open" disabled={busy} onClick={() => void open()}>{t('aiSetup.folder.open')}<small>{t('aiSetup.folder.openHint')}</small></button> : null}
        <button type="button" className="btn" data-answer="switch" disabled={busy} onClick={() => setSwitching(true)}>{t('aiSetup.folder.switch')}<small>{t('aiSetup.folder.switchHint')}</small></button>
        <button type="button" className="btn ghost" data-answer="demo" disabled={busy} onClick={() => void demo()}>{t('aiSetup.folder.demo')}</button>
      </Answers>
      {switching ? (
        <>
          <Me text={t('aiSetup.folder.switch')} />
          <Ai><p>{t('aiSetup.folder.switchSay')}</p></Ai>
          <Answers><button type="button" className="btn primary" data-answer="create-switch" disabled={busy} onClick={() => void create()}>{t('aiSetup.folder.create')}<small>{t('aiSetup.folder.createHint')}</small></button></Answers>
        </>
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
      <div className="obind"><button type="button" className="linkbtn" data-act="by-hand" onClick={onForm}>{t('desktop.flow.byHand')}</button></div>
      {error ? <p className="warnline" role="alert">{error}</p> : null}
    </div>
  );
}
