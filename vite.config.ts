import { defineConfig } from 'vite';

// Served from https://<user>.github.io/bne-flood-watch/ — every asset and data URL must be relative.
export default defineConfig({
  base: '/bne-flood-watch/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
