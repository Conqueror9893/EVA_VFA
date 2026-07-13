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
        welcome: resolve(__dirname, 'welcome.html'),
        component: resolve(__dirname, 'component.html'),
      },
    },
  },
});
