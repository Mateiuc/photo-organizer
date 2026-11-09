import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at https://<user>.github.io/photo-organizer/ in production.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? (process.env.BASE_PATH ?? '/photo-organizer/') : '/',
}));
