// Validasi & decoding berkas. Semua pesan kegagalan menjelaskan langkah berikutnya.

const MB = 1024 * 1024;
export const LIMITS = {
  frameBytes: 20 * MB,
  photoBytes: 15 * MB,
  pdfPages: 20,
  maxPixels: 24e6,
  outSide: 2000, // sisi terpanjang hasil
  photoSide: 4096, // foto diperkecil ke sini agar hemat memori
};

export class UserError extends Error {}

/** Kenali jenis berkas dari isinya, bukan dari ekstensi. */
export async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  const text = new TextDecoder('latin1').decode(head);
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'webp';
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'gif';
  if (text.startsWith('BM')) return 'bmp';
  if (text.slice(4, 8) === 'ftyp') {
    // Kotak ftyp ISO-BMFF: brand utama + daftar brand kompatibel.
    const size = Math.min(new DataView(head.buffer).getUint32(0), head.length);
    const brands = [text.slice(8, 12)];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(text.slice(o, o + 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
    if (brands.some((b) => /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b))) return 'heic';
    return 'unknown';
  }
  if (text.includes('%PDF-')) return 'pdf';
  return 'unknown';
}

/** Format gambar yang bisa dibaca langsung oleh browser. */
export const FRAME_IMAGES = ['png', 'webp', 'jpeg', 'avif'];
export const PHOTO_IMAGES = ['jpeg', 'png', 'webp', 'avif', 'heic', 'gif', 'bmp'];

export function checkSize(file, max, what) {
  if (file.size === 0) throw new UserError(`${what} kosong. Pilih berkas lain.`);
  if (file.size > max) {
    throw new UserError(`${what} terlalu besar (${(file.size / MB).toFixed(1)} MB). Maksimal ${max / MB} MB, coba kompres atau ekspor ulang dengan ukuran lebih kecil.`);
  }
}

/** Decode gambar dengan orientasi EXIF diterapkan. */
async function decodeImage(blob) {
  try {
    if ('createImageBitmap' in window) {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    }
  } catch {
    /* jatuh ke <img> */
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new UserError('Gambar tidak bisa dibaca. Berkas mungkin rusak; coba simpan ulang lalu pilih lagi.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

const sizeOf = (img) => ({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });

function checkPixels(img, what) {
  const { w, h } = sizeOf(img);
  if (!w || !h) throw new UserError(`${what} tidak bisa dibaca. Coba berkas lain.`);
  if (w * h > LIMITS.maxPixels) {
    throw new UserError(`${what} terlalu besar (${(w * h / 1e6).toFixed(1)} MP). Maksimal 24 megapiksel, perkecil dulu lalu coba lagi.`);
  }
}

/** Gambar ke kanvas baru dengan sisi terpanjang maksimal `maxSide` (tidak diperbesar). */
function toCanvas(img, maxSide) {
  const { w, h } = sizeOf(img);
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  if (!ctx) throw new UserError('Memori perangkat tidak cukup. Tutup tab lain atau pakai berkas yang lebih kecil.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  return c;
}

export function unsupportedMessage(kind, accepted) {
  if (kind === 'heic') return 'Browser ini belum bisa membaca foto HEIC. Ubah ke JPG dulu (di iPhone: Pengaturan › Kamera › Format › Paling Kompatibel), lalu pilih lagi.';
  if (kind === 'avif') return 'Browser ini belum bisa membaca AVIF. Perbarui browser atau ubah gambar ke JPG/PNG.';
  return `Format berkas tidak didukung. Gunakan ${accepted}.`;
}

/**
 * Baca gambar jadi kanvas (sisi terpanjang maks. `maxSide`), dengan cek megapiksel.
 * Bila browser tidak mampu membaca format ini (HEIC/AVIF), beri pesan khusus format.
 */
export async function loadImage(file, kind, { what, accepted, maxSide }) {
  let img;
  try {
    img = await decodeImage(file);
  } catch (err) {
    if (kind === 'heic' || kind === 'avif') throw new UserError(unsupportedMessage(kind, accepted));
    throw err;
  }
  checkPixels(img, what);
  return toCanvas(img, maxSide);
}
