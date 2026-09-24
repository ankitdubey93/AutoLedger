import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

// createRoot is the React 18+ concurrent entry point; StrictMode
// double-invokes effects in development to surface missing cleanup.
// ThemeProvider wraps everything, including App, because both PlatformLayout
// and AppFrame's top bars need useTheme() for the theme-toggle menu.
createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
