import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/.model-cache/**', '**/test-results/**'] } },
  optimizeDeps: { include: ['@huggingface/transformers', '@noble/hashes/sha256', '@noble/hashes/utils', 'tinyld'] },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  worker: { format: 'es' },
  build: { target: ['es2022', 'chrome105', 'safari15'] },
});
