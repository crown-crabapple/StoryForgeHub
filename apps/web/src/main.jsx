import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (no request leaves the app): Inter for the UI, Literata for headings and prose.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/literata/wght.css';
import '@fontsource-variable/literata/wght-italic.css';
import './theme/tokens.css';
import './theme/base.css';
import { App } from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
