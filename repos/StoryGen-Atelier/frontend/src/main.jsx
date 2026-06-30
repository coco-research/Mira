import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import './index.css';
import './App.css';
import App from './App.jsx';

const theme = createTheme({
  fontFamily: 'Space Grotesk, system-ui, sans-serif',
  headings: { fontFamily: 'Playfair Display, serif' },
  primaryColor: 'cyan',
  defaultRadius: 'lg',
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
