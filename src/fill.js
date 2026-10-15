// Pilih area foto dari warna yang tersambung dengan titik yang diketuk (flood fill).
// Hanya piksel yang mirip warna titik DAN tersambung yang dihapus, jadi tulisan atau
// ornamen yang menimpa area putih tetap utuh.

/** Batas atas toleransi; juga dipakai untuk menghaluskan tepi area. */
export const LOOSE_TOL = 60;
export const STEPS = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 60];
/** Area tumbuh lebih dari ini antar langkah toleransi = mulai bocor ke elemen lain. */
export const LEAK_GROWTH = 0.04;
/** Pinggiran yang dipudarkan hanya bila warnanya dalam (toleransi + ini) dari warna terkunci. */
const EDGE_MARGIN = 12;

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
  const cols = new Int32Array(W), rows = new Int32Array(H); // jumlah piksel area per kolom/baris
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
    const inside = clear ? (i) => data[i * 4 + 3] < 16 : (i) => dist(data, i, c) <= tol;

    let sp = 0;
    stack[sp++] = si;
    region[si] = 1;
    owner[si] = k + 1;
    while (sp) {
      const i = stack[--sp];
      if (!clear) rem[i] = 255;
      count++;
      const x = i % W;
      const y = (i - x) / W;
      cols[x]++;
      rows[y]++;
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

  // Bintik noise: piksel terang (masih dekat warna terkunci) yang hampir seluruhnya dikelilingi
  // area (>= 60% dari 5x5 tetangga) adalah sisa kompresi/bayangan di dalam lubang -> ikut dihapus.
  // Garis/tulisan/logo yang menempel di tepi lubang tetangganya < 50% area, jadi tidak tersentuh;
  // warna gelap tidak pernah tersentuh.
  if (feather && count) {
    const x0 = Math.max(0, minX - 2), x1 = Math.min(W - 1, maxX + 2);
    const y0 = Math.max(0, minY - 2), y1 = Math.min(H - 1, maxY + 2);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    for (let pass = 0; pass < 2; pass++) {
      // Integral image jumlah piksel area (non-transparan-asli) di dalam kotak pembatas.
      const sum = new Int32Array((bw + 1) * (bh + 1));
      for (let y = 0; y < bh; y++) {
        let row = 0;
        for (let x = 0; x < bw; x++) {
          const i = (y + y0) * W + x + x0;
          row += region[i] && owner[i] && !colors[owner[i] - 1].clear ? 1 : 0;
          sum[(y + 1) * (bw + 1) + x + 1] = sum[y * (bw + 1) + x + 1] + row;
        }
      }
      const add = [];
      for (let y = 0; y < bh; y++) {
        const ya = Math.max(0, y - 2), yb = Math.min(bh, y + 3);
        for (let x = 0; x < bw; x++) {
          const i = (y + y0) * W + x + x0;
          if (region[i]) continue;
          const xa = Math.max(0, x - 2), xb = Math.min(bw, x + 3);
          const n = sum[yb * (bw + 1) + xb] - sum[ya * (bw + 1) + xb] - sum[yb * (bw + 1) + xa] + sum[ya * (bw + 1) + xa];
          if (n < 0.6 * (yb - ya) * (xb - xa)) continue;
          // Pemilik: tetangga area mana pun di sekitarnya.
          let k = 0;
          for (let dy = -2; dy <= 2 && !k; dy++) {
            const yy = y + y0 + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -2; dx <= 2; dx++) {
              const xx = x + x0 + dx;
              if (xx >= 0 && xx < W && region[yy * W + xx] && owner[yy * W + xx]) { k = owner[yy * W + xx]; break; }
            }
          }
          if (k && !colors[k - 1].clear && dist(data, i, colors[k - 1]) <= LOOSE_TOL) add.push(i, k);
        }
      }
      if (!add.length) break;
      for (let f = 0; f < add.length; f += 2) {
        const i = add[f];
        region[i] = 1; owner[i] = add[f + 1]; rem[i] = 255;
      }
    }
  }

  // Pinggiran: piksel campuran tepat di luar area yang warnanya masih SANGAT dekat dengan warna
  // terkunci (sedikit di atas toleransinya) ikut dipudarkan sebagian, supaya tidak ada bintik
  // putih. Warna lain (tulisan, logo, kertas) tidak disentuh sama sekali. Lubang yang sudah
  // transparan juga tidak disentuh.
  if (feather && count) {
    const x0 = Math.max(0, minX - 1), x1 = Math.min(W - 1, maxX + 1);
    const y0 = Math.max(0, minY - 1), y1 = Math.min(H - 1, maxY + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (owner[i]) continue;
        // Arah dari area ke piksel ini (dipakai untuk melihat piksel berikutnya ke luar).
        const step = x > 0 && region[i - 1] ? 1 : x < W - 1 && region[i + 1] ? -1
          : y > 0 && region[i - W] ? W : y < H - 1 && region[i + W] ? -W : 0;
        if (!step) continue;
        const c = colors[owner[i - step] - 1];
        if (!c) continue;
        const maxD = Math.min(LOOSE_TOL, c.tol + EDGE_MARGIN);
        if (c.clear || maxD <= c.tol) continue;
        const d = dist(data, i, c);
        if (d >= maxD) continue;
        // Hanya piksel transisi (warnanya terus berubah menjauhi warna terkunci ke arah luar).
        // Warna solid yang kebetulan mirip (mis. tulisan abu muda) tidak disentuh.
        const j = i + step;
        const inside = step === 1 || step === -1 ? x + step >= 0 && x + step < W : j >= 0 && j < W * H;
        if (!inside || dist(data, j, c) <= d + 4) continue;
        rem[i] = Math.round((255 * (maxD - d)) / (maxD - c.tol + 1));
      }
    }
  }

  return { rem, region, count, bbox: maxX < 0 ? null : trimmedBox(cols, rows, W, H), edge };
}

/**
 * Cocokkan lingkaran ke tepi area (kuadrat terkecil + buang titik yang menyimpang, mis. tepi logo
 * yang menimpa lubang). Mengembalikan { cx, cy, r } dalam piksel bila lubangnya memang bulat,
 * atau null untuk bentuk lain (kotak, sobekan kertas, dsb.).
 */
/** Porsi minimal titik tepi yang menempel di lingkaran agar lubang dianggap bulat. */
export const MIN_ROUND = 0.6;
/** Porsi maksimal titik tepi yang bergerigi di sekitar lingkaran (sobekan kertas = bukan bulat). */
export const MAX_ROUGH = 0.23;

export function fitCircle(region, W, H, box) {
  const x0 = Math.max(0, Math.floor(box.x * W)), y0 = Math.max(0, Math.floor(box.y * H));
  const x1 = Math.min(W - 1, Math.ceil((box.x + box.w) * W) - 1), y1 = Math.min(H - 1, Math.ceil((box.y + box.h) * H) - 1);
  const pts = [];
  for (let y = y0; y <= y1; y++) {
    let a = -1, b = -1;
    for (let x = x0, i = y * W + x0; x <= x1; x++, i++) if (region[i]) { if (a < 0) a = x; b = x; }
    if (a >= 0) pts.push(a, y, b, y);
  }
  for (let x = x0; x <= x1; x++) {
    let a = -1, b = -1;
    for (let y = y0, i = y0 * W + x; y <= y1; y++, i += W) if (region[i]) { if (a < 0) a = y; b = y; }
    if (a >= 0) pts.push(x, a, x, b);
  }
  if (pts.length < 80) return null;

  const residualTol = (r) => Math.max(1.5, r * 0.015);
  const inliers = (f, tol) => {
    const keep = [];
    for (let k = 0; k < pts.length; k += 2) {
      if (Math.abs(Math.hypot(pts[k] - f.cx, pts[k + 1] - f.cy) - f.r) <= tol) keep.push(pts[k], pts[k + 1]);
    }
    return keep;
  };
  // Tebakan awal dari kotak pembatas: lubang bisa tertutup sebagian (logo di bawah, maskot di atas),
  // jadi coba lingkaran yang rata tengah, atas, bawah, kiri, dan kanan; ambil yang paling cocok.
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const cands = [
    { cx: mx, cy: my, r: Math.min(bw, bh) / 2 },
    { cx: mx, cy: y0 + bw / 2, r: bw / 2 }, { cx: mx, cy: y1 - bw / 2, r: bw / 2 },
    { cx: x0 + bh / 2, cy: my, r: bh / 2 }, { cx: x1 - bh / 2, cy: my, r: bh / 2 },
  ];
  let fit = null, best = 0;
  for (const c of cands) {
    const n = inliers(c, Math.max(2, c.r * 0.03)).length;
    if (n > best) { best = n; fit = c; }
  }
  for (let it = 0; it < 4 && fit; it++) {
    const keep = inliers(fit, residualTol(fit.r) * (it === 0 ? 2 : 1));
    if (keep.length < 40) return null;
    fit = kasa(keep);
  }
  if (!fit) return null;
  // Sebagian besar tepi harus menempel di lingkaran, dan ukurannya wajar terhadap areanya.
  const near = inliers(fit, residualTol(fit.r)).length;
  const ratio = near / pts.length;
  // Tepi bergerigi (mis. sobekan kertas): banyak titik "hampir" di lingkaran tapi tidak tepat.
  const rough = 1 - near / Math.max(1, inliers(fit, fit.r * 0.05).length);
  if (ratio < MIN_ROUND || rough > MAX_ROUGH) return null;
  if (2 * fit.r < 0.8 * Math.min(bw, bh) || 2 * fit.r > 1.3 * Math.max(bw, bh)) return null;
  return fit;
}

/**
 * Mode bulat: rapikan lubang secara geometris. Lingkaran diperbesar sampai batas lubang yang
 * sebenarnya (gradasi warna lubang yang memudar ke putih ikut terhitung), lalu di dalamnya piksel
 * terang (dekat warna lubang) dihapus KECUALI yang berdekatan dengan elemen desain berwarna
 * (garis luar logo/tulisan). Tepi lingkaran di-antialias supaya mulus.
 * @param rem salinan rem yang akan ditambah; @param base warna titik lubang {r,g,b,a}
 * @returns radius akhir (px)
 */
export function carveCircle(data, W, H, rem, circle, base, { grow = true, region = null } = {}) {
  const { cx, cy } = circle;
  let r = circle.r;
  if (grow && region) {
    // Lubang buatan desainer jarang bulat sempurna: pakai radius terluar lubang yang sebenarnya
    // (persentil 99,5% jarak piksel area ke pusat, maks. 15% di atas lingkaran rata-rata), supaya
    // tidak ada sisa warna lubang di luar lingkaran.
    const lim = r * 1.15, hist = new Uint32Array(Math.ceil(lim) + 2);
    let total = 0;
    const ya = Math.max(0, Math.floor(cy - lim)), yb = Math.min(H - 1, Math.ceil(cy + lim));
    const xa = Math.max(0, Math.floor(cx - lim)), xb = Math.min(W - 1, Math.ceil(cx + lim));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        if (!region[y * W + x]) continue;
        const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (dd <= lim) { hist[Math.floor(dd)]++; total++; }
      }
    }
    let acc = 0;
    for (let k = 0; k < hist.length; k++) { acc += hist[k]; if (acc >= total * 0.995) { r = Math.max(r, k + 1); break; } }
  }
  const rMax = grow ? r * 1.15 : r + 2;
  const x0 = Math.max(0, Math.floor(cx - rMax - 6)), x1 = Math.min(W - 1, Math.ceil(cx + rMax + 6));
  const y0 = Math.max(0, Math.floor(cy - rMax - 6)), y1 = Math.min(H - 1, Math.ceil(cy + rMax + 6));
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const light = (i) => base.a > 15 && dist(data, i, base) <= LOOSE_TOL && data[i * 4 + 3] > 15;
  // Integral image piksel "desain" (bukan terang) untuk cek kedekatan dengan elemen desain.
  const sum = new Int32Array((bw + 1) * (bh + 1));
  for (let y = 0; y < bh; y++) {
    let row = 0;
    for (let x = 0; x < bw; x++) {
      row += light((y + y0) * W + x + x0) ? 0 : 1;
      sum[(y + 1) * (bw + 1) + x + 1] = sum[y * (bw + 1) + x + 1] + row;
    }
  }
  const R = 4; // jarak aman dari elemen desain (px)
  const nearDesign = (x, y) => {
    const xa = Math.max(0, x - x0 - R), xb = Math.min(bw, x - x0 + R + 1);
    const ya = Math.max(0, y - y0 - R), yb = Math.min(bh, y - y0 + R + 1);
    return sum[yb * (bw + 1) + xb] - sum[ya * (bw + 1) + xb] - sum[yb * (bw + 1) + xa] + sum[ya * (bw + 1) + xa] > 0;
  };
  const free = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return false;
    return light(yi * W + xi) && !nearDesign(xi, yi);
  };
  if (grow) {
    // Perbesar selama cincin pada radius itu masih sebagian besar "lubang" (relatif terhadap awalnya;
    // bagian yang tertutup logo/maskot tidak dihitung ulang).
    const N = 360, ring = (rr) => { let n = 0; for (let a = 0; a < N; a++) { const t = (a / N) * Math.PI * 2; if (free(cx + rr * Math.cos(t), cy + rr * Math.sin(t))) n++; } return n; };
    const f0 = ring(r - 2);
    if (f0 > N * 0.2) {
      let rr = r;
      while (rr + 1 <= rMax && ring(rr + 1) >= f0 * 0.7) rr += 1;
      r = Math.max(r, rr);
    }
  }
  const r2 = (r + 1.5) * (r + 1.5);
  for (let y = Math.max(0, Math.floor(cy - r - 2)); y <= Math.min(H - 1, Math.ceil(cy + r + 2)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r - 2)); x <= Math.min(W - 1, Math.ceil(cx + r + 2)); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * W + x;
      if (rem[i] === 255 || !light(i) || nearDesign(x, y)) continue;
      const cov = Math.min(1, Math.max(0, r + 0.5 - Math.sqrt(dx * dx + dy * dy)));
      const v = Math.round(255 * cov);
      if (v > rem[i]) rem[i] = v;
    }
  }
  return r;
}

/** Lingkaran kuadrat terkecil (metode Kåsa) dari titik [x, y, x, y, ...]. */
function kasa(p) {
  const n = p.length / 2;
  let mx = 0, my = 0;
  for (let k = 0; k < p.length; k += 2) { mx += p[k]; my += p[k + 1]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let k = 0; k < p.length; k += 2) {
    const u = p[k] - mx, v = p[k + 1] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const bu = 0.5 * (suuu + suvv), bv = 0.5 * (svvv + svuu);
  const uc = (bu * svv - bv * suv) / det, vc = (suu * bv - suv * bu) / det;
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

/**
 * Kotak pembatas area yang mengabaikan "ekor" tipis: kolom/baris yang isinya < 3% dari kolom/baris
 * terpadat (mis. area putih yang tersambung ke kilau kecil di tepi cincin) tidak ikut dihitung.
 */
function trimmedBox(cols, rows, W, H) {
  const span = (arr) => {
    let max = 0;
    for (const v of arr) if (v > max) max = v;
    const th = Math.max(1, max * 0.03);
    let a = 0, b = arr.length - 1;
    while (a < b && arr[a] < th) a++;
    while (b > a && arr[b] < th) b--;
    return [a, b];
  };
  const [x0, x1] = span(cols);
  const [y0, y1] = span(rows);
  return { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
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
      } else if (grow > LEAK_GROWTH) {
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
