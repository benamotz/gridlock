import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // Lets the browser talk to the game server on the same origin in dev,
      // so no CORS handling or VITE_SERVER_URL is needed locally.
      '/ws': { target: 'ws://localhost:2567', ws: true },
      '/api': { target: 'http://localhost:2567' },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
