// Pilih area foto dari warna yang tersambung dengan titik yang diketuk (flood fill).
// Hanya piksel yang mirip warna titik DAN tersambung yang dihapus, jadi tulisan atau
// ornamen yang menimpa area putih tetap utuh.

export const DEFAULT_TOL = 60;

/**
 * @param {Uint8ClampedArray} data RGBA bingkai sumber
 * @param {{x:number,y:number}[]} seeds titik relatif 0..1
 * @returns {{ rem: Uint8Array, region: Uint8Array, count: number, bbox: {x,y,w,h}|null, edge: boolean }}
 *   rem = seberapa banyak alpha dihapus per piksel (0..255); region = piksel yang termasuk area
 */
export function floodRemoval(data, W, H, seeds, tol) {
  const n = W * H;
  const rem = new Uint8Array(n);
  const region = new Uint8Array(n);
  const stack = new Int32Array(n);
  const soft = tol * 0.55; // di bawah ini dihapus penuh, di atasnya memudar (tepi halus)
  let count = 0, minX = W, minY = H, maxX = -1, maxY = -1, edge = false;

  for (const s of seeds) {
    const sx = Math.min(W - 1, Math.max(0, Math.floor(s.x * W)));
    const sy = Math.min(H - 1, Math.max(0, Math.floor(s.y * H)));
    const si = sy * W + sx;
    if (region[si]) continue;

    // Titik di lubang yang sudah transparan: ikuti piksel transparan saja dan jangan ubah
    // apa pun, supaya glow semi-transparan di tepi lubang tetap utuh.
    const clearSeed = data[si * 4 + 3] < 16;
    const o0 = si * 4;
    const r0 = data[o0], g0 = data[o0 + 1], b0 = data[o0 + 2], a0 = data[o0 + 3];
    const dist = (i) => {
      const o = i * 4;
      return Math.max(Math.abs(data[o] - r0), Math.abs(data[o + 1] - g0), Math.abs(data[o + 2] - b0), Math.abs(data[o + 3] - a0));
    };
    const inside = clearSeed ? (i) => data[i * 4 + 3] < 16 : (i) => dist(i) <= tol;

    let sp = 0;
    stack[sp++] = si;
    region[si] = 1;
    while (sp) {
      const i = stack[--sp];
      if (!clearSeed) {
        const d = dist(i);
        const v = d <= soft ? 255 : Math.round((255 * (tol - d)) / (tol - soft));
        if (v > rem[i]) rem[i] = v;
      }
      count++;
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      if (x > 0) visit(i - 1);
      if (x < W - 1) visit(i + 1);
      if (y > 0) visit(i - W);
      if (y < H - 1) visit(i + W);
    }

    function visit(j) {
      if (!region[j] && inside(j)) { region[j] = 1; stack[sp++] = j; }
    }
  }

  const bbox = maxX < 0 ? null : {
    x: minX / W, y: minY / H, w: (maxX - minX + 1) / W, h: (maxY - minY + 1) / H,
  };
  return { rem, region, count, bbox, edge };
}

/** Coba temukan area polos di tengah bingkai (mis. lingkaran putih) tanpa bantuan pengguna. */
export function autoSeed(data, W, H) {
  const seed = { x: 0.5, y: 0.5 };
  const res = floodRemoval(data, W, H, [seed], DEFAULT_TOL);
  if (!res.bbox || res.edge) return null;
  const n = W * H;
  const box = res.bbox.w * W * res.bbox.h * H;
  // Cukup besar, tidak menelan seluruh bingkai, dan bentuknya padat (bukan garis tipis).
  if (res.count < n * 0.03 || res.count > n * 0.75 || res.count / box < 0.35) return null;
  return seed;
}
