import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const rootElement = document.getElementById('root')!;

try {
  // Check for critical configuration
  const missingKeys = [
    !import.meta.env.VITE_FIREBASE_API_KEY && 'VITE_FIREBASE_API_KEY',
    !import.meta.env.VITE_FIREBASE_PROJECT_ID && 'VITE_FIREBASE_PROJECT_ID',
  ].filter(Boolean);

  if (missingKeys.length > 0) {
    throw new Error(`Critical Config Missing: ${missingKeys.join(', ')}. Check Netlify Env Variables.`);
  }

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error: any) {
  console.error('Hype Board Crash:', error);
  rootElement.innerHTML = `
    <div style="background: #09090b; color: #ef4444; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; text-align: center; font-family: monospace;">
      <h1 style="font-size: 2rem; margin-bottom: 1rem;">🚀 HYP BOARD RESCUE SCREEN</h1>
      <p style="color: #a1a1aa; max-width: 600px; margin-bottom: 2rem;">The app failed to start. This usually means a key is missing on Netlify.</p>
      <div style="background: #18181b; padding: 1.5rem; border-radius: 8px; border: 1px solid #27272a; color: #fff; text-align: left; width: 100%; max-width: 600px; overflow: auto;">
        <code>${error.message}</code>
      </div>
      <button onclick="window.location.reload()" style="margin-top: 2rem; background: #fff; color: #000; padding: 0.75rem 1.5rem; border-radius: 4px; border: none; font-weight: bold; cursor: pointer;">TRY AGAIN</button>
    </div>
  `;
}
