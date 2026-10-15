// Deteksi lubang transparan di dalam bingkai PNG/WebP.
// Area transparan yang menyentuh tepi gambar (mis. sudut bingkai bulat) diabaikan;
// yang dipilih adalah lubang tertutup terbesar. Hasilnya satu titik di dalam lubang,
// yang lalu diperlakukan sama seperti ketukan pengguna.

const GRID = 256;

export function detectHole(canvas) {
  const W = canvas.width;
  const H = canvas.height;
  const k = Math.min(1, GRID / Math.max(W, H));
  const gw = Math.max(1, Math.round(W * k));
  const gh = Math.max(1, Math.round(H * k));

  const small = document.createElement('canvas');
  small.width = gw;
  small.height = gh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, gw, gh);
  const px = sctx.getImageData(0, 0, gw, gh).data;

  const n = gw * gh;
  const clear = new Uint8Array(n);
  let any = 0;
  // Ambang ketat: sel kecil harus benar-benar transparan agar titiknya jatuh di dalam lubang.
  for (let i = 0; i < n; i++) if (px[i * 4 + 3] < 8) { clear[i] = 1; any++; }
  if (any < n * 0.01) return null;

  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let best = null;

  for (let start = 0; start < n; start++) {
    if (!clear[start] || label[start] !== -1) continue;
    let sp = 0;
    stack[sp++] = start;
    label[start] = start;
    let count = 0, minX = gw, minY = gh, maxX = 0, maxY = 0, edge = false;
    while (sp) {
      const i = stack[--sp];
      const x = i % gw;
      const y = (i - x) / gw;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) edge = true;
      if (x > 0) push(i - 1);
      if (x < gw - 1) push(i + 1);
      if (y > 0) push(i - gw);
      if (y < gh - 1) push(i + gw);
    }
    if (!edge && count >= n * 0.01 && (!best || count > best.count)) {
      best = { id: start, count, minX, minY, maxX, maxY };
    }

    function push(j) {
      if (clear[j] && label[j] === -1) { label[j] = start; stack[sp++] = j; }
    }
  }
  if (!best) return null;

  // Titik lubang yang paling dekat ke tengah kotak pembatasnya.
  const cx = (best.minX + best.maxX) / 2;
  const cy = (best.minY + best.maxY) / 2;
  let seed = null;
  let bestD = Infinity;
  for (let y = best.minY; y <= best.maxY; y++) {
    for (let x = best.minX; x <= best.maxX; x++) {
      if (label[y * gw + x] !== best.id) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) { bestD = d; seed = { x: (x + 0.5) / gw, y: (y + 0.5) / gh }; }
    }
  }
  return seed;
}
