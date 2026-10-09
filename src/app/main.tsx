import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
