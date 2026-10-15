import { defineConfig } from 'vite';

/**
 * Saat build: tanam CSS langsung di HTML (satu request lebih sedikit sebelum halaman tampil)
 * dan preload font agar diunduh bersamaan dengan HTML, bukan menunggu CSS selesai.
 */
function inlineCssAndPreloadFont() {
  return {
    name: 'inline-css-preload-font',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const html = bundle['index.html'];
      if (!html) return;
      let source = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (!name.endsWith('.css')) continue;
        const link = new RegExp(`<link rel="stylesheet"[^>]*href="/${name.replace(/[.]/g, '\\.')}"[^>]*>`);
        if (!link.test(source)) continue;
        source = source.replace(link, () => `<style>${file.source}</style>`);
        delete bundle[name];
      }
      const font = Object.keys(bundle).find((n) => n.endsWith('.woff2'));
      if (font) {
        source = source.replace('<title>', `<link rel="preload" href="/${font}" as="font" type="font/woff2" crossorigin>\n  <title>`);
      }
      html.source = source;
    },
  };
}

export default defineConfig({
  plugins: [inlineCssAndPreloadFont()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    // pdf.js besar tapi hanya dimuat saat pengguna membuka PDF.
    chunkSizeWarningLimit: 1500,
  },
});
