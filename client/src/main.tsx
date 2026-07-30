import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

// createRoot is the React 18+ concurrent entry point; StrictMode
// double-invokes effects in development to surface missing cleanup.
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
