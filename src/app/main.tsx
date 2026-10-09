import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.js';
import { useLanguage } from './hooks/use-display-prefs.js';

/** A new language remounts the app, so every text, including module-level ones, is read again. */
function Root() {
  const [language, setLanguage] = useLanguage();
  return <App key={language} language={language} onLanguage={setLanguage} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
