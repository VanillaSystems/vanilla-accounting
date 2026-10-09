import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts: no request to Google, and an audit export works offline.
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/figtree/900.css';
import '@fontsource/roboto-condensed/400.css';
import '@fontsource/roboto-condensed/500.css';
import '@fontsource/roboto-condensed/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './index.css';
import App from './App.js';
import { useLanguage } from './hooks/use-display-prefs.js';
import { STATIC_EXPORT } from './lib/api.js';

/** A new language remounts the app, so every text, including module-level ones, is read again. */
function Root() {
  const [language, setLanguage] = useLanguage();
  return <App key={language} language={language} onLanguage={setLanguage} />;
}

// The export's view lives after '#': a link pasted into the same tab changes only the hash, and the
// app reads its view once at load, as it does from a server path.
if (STATIC_EXPORT) window.addEventListener('hashchange', () => window.location.reload());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
