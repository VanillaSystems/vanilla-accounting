/**
 * «Einrichtung» before any books (docs/0.4.0/ai-setup.md, design B): the conversation opens with the
 * AI, then asks for the folder. Every step is drawn by code from this Mac's AI setup
 * (src/app/ai/useAiSetup.ts), so it works before any AI exists: the answers are buttons. Once a CLI
 * or a key is ready, or the person goes on without AI (remembered on this Mac), it asks where the
 * books go; «Dieser Ordner passt» starts the setup conversation there (src/app/onboarding/DraftConversation.tsx).
 */
import { useState, type ReactNode } from 'react';
import { FIRST_RUN_CLIS, planName, type CardState, type SetupKey } from '../../platform/ai-setup.js';
import { AI_CLIS } from '../../platform/terminal.js';
import type { DesktopInfo } from '../../types/desktop.js';
import { language, t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { desktop } from '../desktop/bridge.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ICONS } from '../areas/icons.js';
import { CliCard } from './CliCard.js';
import { KeyBlock } from './KeyBlock.js';
import { useAiSetup } from './useAiSetup.js';
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

const CLI = FIRST_RUN_CLIS[0];

export function FirstRun({ info, onSetup, onForm, onLeave }: { info: DesktopInfo | null; onSetup(root: string): void; onForm(): void; onLeave(): void }) {
  const ai = useAiSetup();
  const name = t(`terminal.cli.${CLI}`);
  const [said, setSaid] = useState<Array<'install' | 'signIn' | 'noAi'>>([]);
  const [keyReady, setKeyReady] = useState<SetupKey>();
  const card: CardState | undefined = ai.cards[CLI];
  const view = ai.view;
  const say = (what: 'install' | 'signIn' | 'noAi') => setSaid((s) => [...s, what]);
  const install = () => { say('install'); void ai.install(CLI); };
  const signIn = () => { say('signIn'); void ai.signIn(CLI); };
  const noAi = () => { say('noAi'); void ai.choose({ noAi: true }); };
  const takeBackNoAi = () => { setSaid((s) => s.filter((x) => x !== 'noAi')); void ai.choose({ noAi: false }); };

  const chosenNoAi = said.includes('noAi');
  const keptNoAi = !!view?.noAi && !chosenNoAi && card?.kind !== 'ready';
  const ready = card?.kind === 'ready';
  const done = ready || !!keyReady || chosenNoAi || keptNoAi;
  const foundLine = !!card && 'version' in card && !!card.version && (card.kind === 'signedOut' || card.kind === 'signingIn' || card.kind === 'testing'
    || card.kind === 'refused' || (card.kind === 'notFound' && card.waited === 'signIn') || (ready && said.length > 0));
  const NoAiButton = <button type="button" className="btn" data-answer="no-ai" onClick={noAi}>{t('aiSetup.answer.noAi')}<small>{t('aiSetup.answer.noAiHint')}</small></button>;

  return (
    <div className="obflow" aria-label={t('onboarding.title')}>
      <header className="obflowhd">
        <span className="obwho">
          <span className="obface"><BotIcon /></span>
          <span><b>{t('onboarding.title')}</b><small>{t('onboarding.who')}</small></span>
        </span>
        <button type="button" className="linkbtn" data-act="first-leave" onClick={onLeave}>{t('aiSetup.toStart')}</button>
      </header>
      <div className="obflowturns">
        <Ai><p>{t(keptNoAi ? 'aiSetup.helloNoAi' : 'aiSetup.hello')}</p></Ai>
        {!view || !card ? (ai.error ? <p className="warnline" role="alert">{ai.error}</p> : <Ai><p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.looking')}</p></Ai>) : keptNoAi ? null : (
          <>
            {!said.includes('install') && !ready ? (
              <>
                <div className="obind"><div className="obcard aiobcard">
                  {FIRST_RUN_CLIS.map((cli) => ai.cards[cli] && <CliCard key={cli} cli={cli} state={ai.cards[cli]!} opens={view.opens} compact />)}
                </div></div>
                <div className="obind"><KeyBlock view={view} onSave={ai.saveKey} onKept={setKeyReady} /></div>
                {!done && (card.kind === 'missing' || card.kind === 'silent' || card.kind === 'notFound') ? (
                  <Answers>
                    {view.opens ? <button type="button" className="btn primary" data-answer="install" onClick={install}>{t('aiSetup.answer.install', { cli: name })}<small>{t('aiSetup.answer.installHint', { vendor: AI_CLIS[CLI].vendor })}</small></button> : null}
                    {NoAiButton}
                  </Answers>
                ) : null}
              </>
            ) : null}
            {said.includes('install') ? (
              <>
                <Me text={t('aiSetup.answer.install', { cli: name })} />
                <Ai><p>{t(view.opens ? 'aiSetup.say.terminalOpened' : 'aiSetup.say.copy', { vendor: AI_CLIS[CLI].vendor })}</p></Ai>
                {card.kind === 'installing' || card.kind === 'missing' || card.kind === 'notFound' || card.kind === 'silent' ? (
                  <div className="obind"><div className="obcard aiobcard"><CliCard cli={CLI} state={card} opens={view.opens} compact actions={card.kind === 'notFound' || card.kind === 'silent' ? { install, signIn, again: () => ai.again(CLI) } : undefined} /></div></div>
                ) : null}
                {card.kind === 'notFound' && !done ? <Answers>{NoAiButton}</Answers> : null}
              </>
            ) : null}
            {foundLine && 'version' in card ? <Ai><p>{t('aiSetup.say.found', { cli: name, version: card.version ?? '' })}</p></Ai> : null}
            {(card.kind === 'signedOut' || (card.kind === 'notFound' && card.waited === 'signIn')) && !said.includes('signIn') && !done ? (
              <Answers>
                {view.opens ? <button type="button" className="btn primary" data-answer="sign-in" onClick={signIn}>{t('aiSetup.signIn')}<small>{t('aiSetup.answer.signInHint', { command: `${AI_CLIS[CLI].program} ${AI_CLIS[CLI].login.join(' ')}` })}</small></button> : null}
                {NoAiButton}
              </Answers>
            ) : null}
            {said.includes('signIn') ? (
              <>
                <Me text={t('aiSetup.signIn')} />
                <Ai>
                  <p>{t('aiSetup.say.browser')}</p>
                  {card.kind === 'signingIn' ? <p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.signingIn.wait')}</p> : null}
                  {card.kind === 'notFound' ? <p className="warnline">{ICONS.warn}{t('aiSetup.notFound.signIn', { cli: name })}</p> : null}
                </Ai>
                {card.kind === 'notFound' && !done ? <Answers><button type="button" className="btn" onClick={() => ai.again(CLI)}>{t('aiSetup.again')}</button>{NoAiButton}</Answers> : null}
              </>
            ) : null}
            {card.kind === 'testing' ? <Ai><p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.testing')}</p></Ai> : null}
            {card.kind === 'refused' && !done ? (
              <>
                <Ai>
                  <p className="warnline">{ICONS.warn}{t(`aiSetup.refused.${card.why}`, { said: card.said })}</p>
                  <p>{t(card.why === 'plan' ? 'aiSetup.say.planNeeded' : 'aiSetup.say.refusedWays')}</p>
                </Ai>
                <Answers>
                  <a className="btn" href={AI_CLIS[CLI].plans} target="_blank" rel="noopener noreferrer">{t('aiSetup.plans', { vendor: AI_CLIS[CLI].vendor })}{ICONS.external}</a>
                  {view.opens ? <button type="button" className="btn" onClick={signIn}>{t('aiSetup.otherAccount')}</button> : null}
                  <button type="button" className="btn" onClick={() => ai.again(CLI)}>{t('aiSetup.again')}</button>
                  {NoAiButton}
                </Answers>
              </>
            ) : null}
          </>
        )}
        {ready ? <Ai><p className="okline" data-ready={CLI}>{ICONS.check}{t('aiSetup.say.ready', { cli: name, plan: card.plan ? planName(card.plan) : t('aiSetup.fact.yes') })}</p></Ai> : null}
        {keyReady && !ready ? <Ai><p className="okline" data-ready={keyReady}>{ICONS.check}{t('aiSetup.say.keyReady', { provider: t(`aiSetup.key.${keyReady}`) })}</p></Ai> : null}
        {chosenNoAi ? (
          <>
            <Me text={t('aiSetup.answer.noAi')} onChange={takeBackNoAi} />
            <Ai><p>{t('aiSetup.say.noAi')}</p></Ai>
          </>
        ) : null}
        {done ? <FolderStep info={info} onSetup={onSetup} onForm={onForm} /> : null}
        {ai.error && view ? <p className="warnline" role="alert">{ai.error}</p> : null}
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
  const name = freeName(t('desktop.folderName', { year: String(new Date().getFullYear()) }), info?.folders ?? []);
  const run = async (go: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await go(); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  const create = async () => {
    const root = desktop
      ? await desktop.chooseNewFolder({ title: t('aiSetup.folder.createTitle'), name, button: t('aiSetup.folder.createButton') })
      : info ? `${info.booksHome}/${name}` : null;
    if (!root) return;
    setChosen(root);
    await run(async () => {
      const begun = await api.desktop.setupBegin(root, language());
      if (begun.kind === 'books') location.assign('/');
      else onSetup(begun.view.root);
    });
  };
  const open = async () => {
    const dir = await desktop?.chooseFolder(t('desktop.chooseOpen'));
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
      <div className="obind"><button type="button" className="linkbtn" data-act="by-hand" onClick={onForm}>{t('desktop.flow.byHand')}</button></div>
      {error ? <p className="warnline" role="alert">{error}</p> : null}
    </div>
  );
}
