import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PatientCheckIn } from './PatientCheckIn';
import { ProviderView } from './ProviderView';
import { RoleLanding } from './RoleLanding';
import { PatientPicker } from './PatientPicker';
import { api } from './api';
import type { Capabilities } from '../shared/types';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/latin-800.css';
import './styles.css';
const path = window.location.pathname.replace(/\/$/, '');
const checkIn = /^\/c\/([a-z0-9]{32})$/i.exec(path);
const root = createRoot(document.getElementById('root')!);

function render(node: React.ReactNode) { root.render(<React.StrictMode>{node}</React.StrictMode>); }

if (checkIn) render(<PatientCheckIn token={checkIn[1]} />);
else if (path === '/nurse') render(<App />);
else if (path === '/patient') render(<PatientPicker />);
else if (path === '/provider') {
  // The provider's briefing needs the same model the nurse's does.
  render(<ProviderView chatReady={false} chatReason="Checking briefing availability…" />);
  void api<Capabilities>('/capabilities')
    .then(c => render(<ProviderView chatReady={c.chat} chatReason={c.chatReason} />))
    .catch(() => render(<ProviderView chatReady={false} chatReason="Could not check briefing availability." />));
} else render(<RoleLanding />);
