// Pilih area foto dari warna yang tersambung dengan titik yang diketuk (flood fill).
// Hanya piksel yang mirip warna titik DAN tersambung yang dihapus, jadi tulisan atau
// ornamen yang menimpa area putih tetap utuh.

/** Batas atas toleransi; juga dipakai untuk menghaluskan tepi area. */
export const LOOSE_TOL = 60;
const STEPS = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 60];
const FEATHER_PX = 2;

/**
 * @param {Uint8ClampedArray} data RGBA bingkai sumber
 * @param {{x:number,y:number,tol?:number}[]} seeds titik relatif 0..1, masing-masing dengan toleransinya
 * @returns {{ rem: Uint8Array, region: Uint8Array, count: number, bbox: {x,y,w,h}|null, edge: boolean }}
 *   rem = seberapa banyak alpha dihapus per piksel (0..255); region = piksel yang termasuk area
 */
export function floodRemoval(data, W, H, seeds, defaultTol = LOOSE_TOL, { feather = true } = {}) {
  const n = W * H;
  const rem = new Uint8Array(n);
  const region = new Uint8Array(n);
  const owner = new Uint8Array(n); // indeks titik + 1 pemilik piksel (area + tepi halus)
  const stack = new Int32Array(n);
  const colors = [];
  let count = 0, minX = W, minY = H, maxX = -1, maxY = -1, edge = false;

  seeds.forEach((s, k) => {
    const sx = Math.min(W - 1, Math.max(0, Math.floor(s.x * W)));
    const sy = Math.min(H - 1, Math.max(0, Math.floor(s.y * H)));
    const si = sy * W + sx;
    const o0 = si * 4;
    const tol = s.tol ?? defaultTol;
    // Titik di lubang yang sudah transparan: ikuti piksel transparan saja dan jangan ubah
    // apa pun, supaya glow semi-transparan di tepi lubang tetap utuh.
    const clear = data[o0 + 3] < 16;
    colors.push({ r: data[o0], g: data[o0 + 1], b: data[o0 + 2], a: data[o0 + 3], tol, clear });
    if (region[si]) return;

    const c = colors[k];
    const soft = tol * 0.55; // di bawah ini dihapus penuh, di atasnya memudar
    const inside = clear ? (i) => data[i * 4 + 3] < 16 : (i) => dist(data, i, c) <= tol;

    let sp = 0;
    stack[sp++] = si;
    region[si] = 1;
    owner[si] = k + 1;
    while (sp) {
      const i = stack[--sp];
      if (!clear) {
        const d = dist(data, i, c);
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
      if (!region[j] && inside(j)) { region[j] = 1; owner[j] = k + 1; stack[sp++] = j; }
    }
  });

  // Tepi halus: piksel campuran (anti-aliasing) tepat di luar area ikut memudar,
  // hanya sejauh beberapa piksel sehingga tidak bisa bocor ke elemen lain.
  if (feather && count) {
    let frontier = [];
    for (let y = Math.max(0, minY - 1); y <= Math.min(H - 1, maxY + 1); y++) {
      for (let x = Math.max(0, minX - 1); x <= Math.min(W - 1, maxX + 1); x++) {
        const i = y * W + x;
        if (owner[i]) continue;
        const k = (x > 0 && owner[i - 1]) || (x < W - 1 && owner[i + 1]) || (y > 0 && owner[i - W]) || (y < H - 1 && owner[i + W]);
        if (k) frontier.push(i, k);
      }
    }
    for (let ring = 0; ring < FEATHER_PX && frontier.length; ring++) {
      const next = [];
      for (let f = 0; f < frontier.length; f += 2) {
        const i = frontier[f], k = frontier[f + 1];
        if (owner[i]) continue;
        const c = colors[k - 1];
        if (c.clear) continue;
        const d = dist(data, i, c);
        if (d > LOOSE_TOL) continue;
        owner[i] = k;
        const v = Math.round((230 * (LOOSE_TOL - d)) / Math.max(1, LOOSE_TOL - c.tol));
        if (v > rem[i]) rem[i] = Math.min(255, v);
        const x = i % W;
        const y = (i - x) / W;
        if (x > 0 && !owner[i - 1]) next.push(i - 1, k);
        if (x < W - 1 && !owner[i + 1]) next.push(i + 1, k);
        if (y > 0 && !owner[i - W]) next.push(i - W, k);
        if (y < H - 1 && !owner[i + W]) next.push(i + W, k);
      }
      frontier = next;
    }
  }

  const bbox = maxX < 0 ? null : {
    x: minX / W, y: minY / H, w: (maxX - minX + 1) / W, h: (maxY - minY + 1) / H,
  };
  return { rem, region, count, bbox, edge };
}

function dist(data, i, c) {
  const o = i * 4;
  return Math.max(Math.abs(data[o] - c.r), Math.abs(data[o + 1] - c.g), Math.abs(data[o + 2] - c.b), Math.abs(data[o + 3] - c.a));
}

/**
 * Toleransi otomatis untuk satu titik: naikkan bertahap dan berhenti tepat sebelum area
 * "melompat" (tanda mulai bocor ke kertas/label yang warnanya mirip).
 */
export function pickTolerance(data, W, H, seed) {
  let prev = 0, best = STEPS[0], stable = false;
  for (const t of STEPS) {
    const { count } = floodRemoval(data, W, H, [{ ...seed, tol: t }], t, { feather: false });
    if (prev) {
      const grow = count / prev - 1;
      if (!stable) {
        // Fase awal: area masih tumbuh karena noise/kompresi; tunggu sampai stabil.
        if (grow < 0.03) stable = true;
        else if (grow > 0.5 && prev > W * H * 0.02) break;
      } else if (grow > 0.06) {
        break;
      }
    }
    best = t;
    prev = count;
  }
  return best;
}

/** Coba temukan area polos di tengah bingkai (mis. lingkaran putih) tanpa bantuan pengguna. */
export function autoSeed(data, W, H) {
  const seed = { x: 0.5, y: 0.5 };
  seed.tol = pickTolerance(data, W, H, seed);
  const res = floodRemoval(data, W, H, [seed], seed.tol, { feather: false });
  if (!res.bbox || res.edge) return null;
  const n = W * H;
  const box = res.bbox.w * W * res.bbox.h * H;
  // Cukup besar, tidak menelan seluruh bingkai, dan bentuknya padat (bukan garis tipis).
  if (res.count < n * 0.03 || res.count > n * 0.75 || res.count / box < 0.35) return null;
  return seed;
}
