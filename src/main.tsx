import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installApiFetch } from './lib/apiFetch';
import { AppErrorBoundary } from './components/AppErrorBoundary';
installApiFetch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);


