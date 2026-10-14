import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts: no request to Google, and an audit export works offline.
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/hanken-grotesk/800.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/instrument-sans/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/detail.css';
import { Shell } from './shell/Shell.js';
import { useLanguage } from './shell/prefs.js';
import { desktop, noTitleBar } from './desktop/bridge.js';
import { StartScreen, useStartScreen } from './desktop/StartScreen.js';

if (noTitleBar) document.documentElement.classList.add('no-titlebar');

/** A new language remounts the app, so every text, including module-level ones, is read again. */
function Root() {
  const start = useStartScreen();
  const [language, setLanguage] = useLanguage(start === false);
  useEffect(() => { desktop?.setLanguage(language); }, [language]);
  if (start === undefined) return null;
  return start
    ? <StartScreen key={language} language={language} onLanguage={setLanguage} />
    : <Shell key={language} language={language} onLanguage={setLanguage} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
