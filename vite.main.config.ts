import { defineConfig } from 'vite';
import path from 'node:path';

// Main process. Built to CommonJS; Electron loads `.vite/build/index.js`.
export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
    // Load the Node build of any isomorphic dep.
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'src/main/index.ts'),
      output: { format: 'cjs', entryFileNames: '[name].js' },
    },
  },
});
