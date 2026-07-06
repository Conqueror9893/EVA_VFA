import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        avatar: resolve(__dirname, 'avatar-screen.html'),
        interaction: resolve(__dirname, 'interaction-screen.html'),
      },
    },
  },
});
