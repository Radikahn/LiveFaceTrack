import { defineConfig } from 'vite';
import path from 'node:path';

// Preload runs in a sandboxed context: CommonJS only, no ESM.
export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'src/preload/index.ts'),
      output: { format: 'cjs', entryFileNames: 'preload.js', inlineDynamicImports: true },
    },
  },
});
