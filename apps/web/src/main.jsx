import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installFocusRestore } from './shell/focus-restore.js';
// Self-hosted fonts (no request leaves the app): Inter for the UI, Literata for headings and prose.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/literata/wght.css';
import '@fontsource-variable/literata/wght-italic.css';
import './theme/tokens.css';
import './theme/base.css';
import { App } from './App.jsx';
import './styles.css';
import './insights/insights.css';
import './canvas/canvas.css';
import './workspace/workspace.css';
import './responsive.css';

installFocusRestore();
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
