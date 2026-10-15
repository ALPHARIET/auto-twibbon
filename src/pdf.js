// pdf.js hanya dimuat saat pengguna membuka PDF, supaya halaman awal tetap ringan.
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { LIMITS, UserError } from './files.js';

let lib;
async function load() {
  if (!lib) {
    lib = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  return lib;
}

export async function openPdf(data) {
  const pdfjs = await load();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      enableXfa: false,
      disableAutoFetch: true,
      stopAtErrors: false,
    }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new UserError('PDF ini dikunci password. Simpan salinan tanpa password (atau ekspor ke PNG), lalu unggah lagi.');
    }
    throw new UserError('PDF tidak bisa dibaca. Berkas mungkin rusak; coba ekspor ulang atau gunakan PNG.');
  }
  if (doc.numPages > LIMITS.pdfPages) {
    const n = doc.numPages;
    doc.destroy();
    throw new UserError(`PDF berisi ${n} halaman. Maksimal ${LIMITS.pdfPages} halaman; pisahkan halaman bingkainya saja lalu unggah lagi.`);
  }
  return doc;
}

/** Render satu halaman ke kanvas transparan dengan sisi terpanjang `side` piksel. */
export async function renderPage(doc, pageNumber, side) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: side / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  // Konteks dibuat sendiri dengan alpha; jika pdf.js yang membuat, latarnya jadi opak.
  const canvasContext = canvas.getContext('2d', { alpha: true });
  if (!canvasContext) throw new UserError('Memori perangkat tidak cukup untuk merender PDF. Coba gunakan PNG.');
  await page.render({
    canvas: null,
    canvasContext,
    viewport,
    background: 'rgba(0,0,0,0)',
    annotationMode: lib.AnnotationMode.ENABLE,
  }).promise;
  page.cleanup();
  return canvas;
}
