import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Webview bundle: fixed file names so the extension can reference them.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/webview',
  base: './',
  build: {
    outDir: '../../dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/webview/main.tsx',
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: 'index-[name].js',
        assetFileNames: 'index.[ext]',
        inlineDynamicImports: true,
      },
    },
  },
});
