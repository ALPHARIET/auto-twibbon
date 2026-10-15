import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    // pdf.js besar tapi hanya dimuat saat pengguna membuka PDF.
    chunkSizeWarningLimit: 1500,
  },
});
