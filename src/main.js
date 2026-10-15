import './style.css';
import {
  LIMITS, UserError, sniff, checkSize, loadImage, unsupportedMessage,
  FRAME_IMAGES, PHOTO_IMAGES,
} from './files.js';
import { detectHole } from './detect.js';
import { floodRemoval, autoSeed, pickTolerance, fitCircle, carveCircle, STEPS, LEAK_GROWTH } from './fill.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const el = {
  stage: $('#stage'), view: $('#view'), drop: $('#drop'), busy: $('#busy'), busyText: $('#busyText'),
  hint: $('#stageHint'), toast: $('#toast'),
  frameInput: $('#frameInput'), photoInput: $('#photoInput'),
  pdfPages: $('#pdfPages'), pageGrid: $('#pageGrid'),
  undo: $('#undoBtn'), resetArea: $('#resetAreaBtn'), toPhoto: $('#toPhoto'),
  photoControls: $('#photoControls'), zoom: $('#zoom'), zoomVal: $('#zoomVal'), zoomIn: $('#zoomIn'), zoomOut: $('#zoomOut'), resetPos: $('#resetPos'),
  download: $('#downloadBtn'), share: $('#shareBtn'), openFallback: $('#openFallback'), openLink: $('#openLink'),
};
const ctx = el.view.getContext('2d');

const state = {
  step: 1,
  source: null, // bingkai asli (ukuran keluaran)
  frame: document.createElement('canvas'), // bingkai setelah area putih dihapus
  area: null, // { x, y, w, h } relatif 0..1: kotak tempat foto diletakkan; null = belum ada
  seeds: [], // titik relatif yang diketuk (atau terdeteksi otomatis)
  box: null, // kotak area foto yang diatur manual (relatif); null = otomatis dari area terhapus
  shape: 'rect', // 'circle' = lingkaran di dalam kotak (lubang bulat), 'rect' = kotak
  initialShape: 'rect',
  srcData: null, // piksel bingkai sumber (cache untuk flood fill)
  small: null, // salinan kecil bingkai untuk mencari toleransi dengan cepat
  fillCache: null,
  initialSeeds: [], // untuk reset
  detected: null, // 'hole' | 'fill' | null
  history: [],
  photo: null,
  pos: null, // { cx, cy, zoom } dalam piksel template
  pdf: null,
  pdfPage: 0,
  resultUrl: null,
};

const W = () => state.source.width;
const H = () => state.source.height;

function areaPx() {
  const a = state.area;
  return { x: a.x * W(), y: a.y * H(), w: a.w * W(), h: a.h * H() };
}

/* ================= Bingkai & area ================= */

function sourceData() {
  if (!state.srcData) {
    state.srcData = state.source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W(), H()).data;
  }
  return state.srcData;
}

/** Salinan bingkai maks. 640 px (dihaluskan, agar gradasi tipis penghubung area tetap terlihat). */
function smallData() {
  if (!state.small) {
    const k = Math.min(1, 640 / Math.max(W(), H()));
    const w = Math.max(1, Math.round(W() * k)), h = Math.max(1, Math.round(H() * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(state.source, 0, 0, w, h);
    state.small = { data: g.getImageData(0, 0, w, h).data, w, h };
  }
  return state.small;
}

/**
 * Toleransi otomatis untuk satu titik, dihitung di salinan kecil agar cepat di bingkai besar.
 * Area yang sangat kecil (mis. sela huruf) dihitung ulang di resolusi penuh supaya tetap akurat.
 */
function toleranceFor(seed) {
  const s = smallData();
  const tol = pickTolerance(s.data, s.w, s.h, seed);
  if (s.w === W()) return tol;
  const { count } = floodRemoval(s.data, s.w, s.h, [{ ...seed, tol }], tol, { feather: false });
  return count < 200 ? pickTolerance(sourceData(), W(), H(), seed) : verifyTolerance(seed, tol);
}

/**
 * Cek ulang toleransi di resolusi penuh: jembatan gradasi tipis bisa hilang di salinan kecil.
 * Bila area masih melompat dibanding satu langkah lebih ketat, turunkan toleransinya.
 */
function verifyTolerance(seed, tol) {
  const count = (t) => floodRemoval(sourceData(), W(), H(), [{ ...seed, tol: t }], t, { feather: false }).count;
  let cur = count(tol);
  for (let j = STEPS.indexOf(tol) - 1; j >= 0; j--) {
    const lower = count(STEPS[j]);
    if (cur / lower - 1 <= LEAK_GROWTH) break;
    tol = STEPS[j];
    cur = lower;
  }
  return tol;
}

/** Hasil flood fill untuk titik-titik saat ini (di-cache selama titiknya sama). */
function fillResult() {
  const key = state.seeds.map((s) => `${s.x},${s.y},${s.tol}`).join(';');
  if (state.fillCache?.key !== key) {
    state.fillCache = { key, res: floodRemoval(sourceData(), W(), H(), state.seeds) };
  }
  return state.fillCache.res;
}

/** Lingkaran yang cocok dengan tepi lubang (di-cache bersama hasil flood fill), atau null. */
function holeCircle() {
  const cache = state.fillCache;
  if (cache.circle === undefined) {
    const res = cache.res;
    cache.circle = res.bbox ? fitCircle(res.region, W(), H(), res.bbox) : null;
  }
  return cache.circle;
}

const framePad = () => Math.max(2, Math.round(Math.min(W(), H()) * 0.005));

/** Warna lubang yang dikunci (titik pertama yang bukan lubang transparan), atau null. */
function baseColor() {
  const d = sourceData();
  for (const sd of state.seeds) {
    const o = (Math.min(H() - 1, Math.floor(sd.y * H())) * W() + Math.min(W() - 1, Math.floor(sd.x * W()))) * 4;
    if (d[o + 3] > 15) return { r: d[o], g: d[o + 1], b: d[o + 2], a: d[o + 3] };
  }
  return null;
}

/**
 * Mode bulat: penghapusan yang dirapikan secara geometris (lingkaran sampai tepi lubang asli,
 * tepi mulus). Di-cache per hasil flood fill + lingkaran. Mengembalikan { rem, cx, cy, r }.
 */
function circleCut(res) {
  const cache = state.fillCache;
  let circle, grow;
  if (state.box) {
    const b = areaPxOf(state.box);
    circle = { cx: b.x + b.w / 2, cy: b.y + b.h / 2, r: Math.min(b.w, b.h) / 2 };
    grow = false;
  } else {
    circle = holeCircle();
    if (!circle) { // lubang tidak bulat sempurna: lingkaran terbesar di dalam kotak pembatasnya
      const b = res.bbox;
      circle = { cx: (b.x + b.w / 2) * W(), cy: (b.y + b.h / 2) * H(), r: Math.min(b.w * W(), b.h * H()) / 2 };
    }
    grow = true;
  }
  const key = `${circle.cx},${circle.cy},${circle.r},${grow}`;
  if (cache.cut?.key !== key) {
    const rem = new Uint8Array(res.rem);
    const base = baseColor();
    const r = base ? carveCircle(sourceData(), W(), H(), rem, circle, base, { grow, region: res.region }) : circle.r;
    cache.cut = { key, rem, cx: circle.cx, cy: circle.cy, r };
  }
  return cache.cut;
}

const areaPxOf = (a) => ({ x: a.x * W(), y: a.y * H(), w: a.w * W(), h: a.h * H() });

/** Kotak otomatis (piksel) untuk mode kotak: kotak pembatas area, sedikit dilebarkan. */
function rectBoxPx(res) {
  const pad = framePad();
  const x0 = Math.max(0, res.bbox.x * W() - pad), y0 = Math.max(0, res.bbox.y * H() - pad);
  const x1 = Math.min(W(), (res.bbox.x + res.bbox.w) * W() + pad), y1 = Math.min(H(), (res.bbox.y + res.bbox.h) * H() + pad);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function rebuildFrame() {
  const f = state.frame;
  if (f.width !== W() || f.height !== H()) { f.width = W(); f.height = H(); }
  const c = f.getContext('2d');
  c.clearRect(0, 0, f.width, f.height);
  state.area = null;
  if (!state.seeds.length) { c.drawImage(state.source, 0, 0); return; }

  const res = fillResult();
  if (!res.bbox) { c.drawImage(state.source, 0, 0); return; }
  let rem = res.rem;
  let disk = null;
  if (state.shape === 'circle') {
    // Lingkaran di dalam kotak: hapus hanya di dalam lingkaran, tepi mulus sampai batas lubang asli.
    const cut = circleCut(res);
    rem = cut.rem;
    const r = cut.r + (state.box ? 0 : Math.max(1, framePad() / 2));
    disk = { cx: cut.cx, cy: cut.cy, r: cut.r + 1 };
    state.area = state.box ? { ...state.box } : { x: (cut.cx - r) / W(), y: (cut.cy - r) / H(), w: (2 * r) / W(), h: (2 * r) / H() };
  } else if (state.box) {
    state.area = { ...state.box };
  } else {
    // Foto diletakkan di kotak ini, sedikit dilebarkan agar menutup tepi halus; kelebihannya tertutup bingkai.
    const b = rectBoxPx(res);
    state.area = { x: b.x / W(), y: b.y / H(), w: b.w / W(), h: b.h / H() };
  }
  const out = new ImageData(new Uint8ClampedArray(sourceData()), W(), H());
  const d = out.data;
  let edited = false;
  for (let i = 0; i < rem.length; i++) {
    let v = rem[i];
    if (!v) continue;
    if (disk) {
      // Warna lubang yang tersambung ke luar lingkaran (gelombang, garis logo) tidak dihapus.
      const x = i % W(), y = (i - x) / W();
      const cov = clamp(disk.r + 0.5 - Math.hypot(x + 0.5 - disk.cx, y + 0.5 - disk.cy), 0, 1);
      v = Math.round(v * cov);
      if (!v) continue;
    }
    d[i * 4 + 3] = (d[i * 4 + 3] * (255 - v)) / 255;
    edited = true;
  }
  // Lubang yang sudah transparan: pakai bingkai apa adanya (tanpa salin ulang piksel).
  if (edited) c.putImageData(out, 0, 0);
  else c.drawImage(state.source, 0, 0);
}

function setFrame(canvas, { shared = false } = {}) {
  state.source = canvas;
  state.srcData = null;
  state.small = null;
  state.fillCache = null;
  const hole = detectHole(canvas);
  const auto = hole ? null : autoSeed(smallData().data, smallData().w, smallData().h);
  if (auto && smallData().w !== W()) auto.tol = verifyTolerance(auto, auto.tol);
  const seed = hole || auto;
  state.detected = hole ? 'hole' : auto ? 'fill' : null;
  state.seeds = seed ? [seed] : [];
  state.box = null;
  state.initialSeeds = [...state.seeds];
  state.history = [];
  // Lubang yang bulat otomatis memakai mode lingkaran-dalam-kotak; bentuk lain memakai kotak.
  state.shape = state.seeds.length && fillResult().bbox && holeCircle() ? 'circle' : 'rect';
  state.initialShape = state.shape;
  rebuildFrame();
  if (state.photo && state.area) resetPos();
  el.view.hidden = false;
  el.drop.hidden = true;
  layoutView();
  // Bingkai yang lubangnya sudah transparan tidak perlu diedit: langsung ke langkah foto.
  // Begitu juga peserta dari tautan bila areanya sudah jelas.
  goStep(state.area && (state.detected === 'hole' || shared) ? 3 : 2);
  if (state.detected === 'hole') toast('Bingkai sudah transparan, langsung pasang foto.');
}

function pushHistory() {
  state.history.push({ seeds: [...state.seeds], box: state.box && { ...state.box }, shape: state.shape });
  if (state.history.length > 30) state.history.shift();
}

function undo() {
  const prev = state.history.pop();
  if (!prev) return;
  state.seeds = prev.seeds;
  state.box = prev.box;
  state.shape = prev.shape;
  areaChanged();
}

function resetArea() {
  pushHistory();
  state.seeds = [...state.initialSeeds];
  state.box = null;
  state.shape = state.initialShape;
  areaChanged();
}

function setShape(shape) {
  if (shape === state.shape || !state.source) return;
  pushHistory();
  state.shape = shape;
  state.box = null;
  areaChanged();
}

/* ---------- Kotak area foto yang bisa diatur ---------- */

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

function handlePoints(r) {
  const mx = r.x + r.w / 2, my = r.y + r.h / 2, x1 = r.x + r.w, y1 = r.y + r.h;
  return { nw: [r.x, r.y], n: [mx, r.y], ne: [x1, r.y], e: [x1, my], se: [x1, y1], s: [mx, y1], sw: [r.x, y1], w: [r.x, my] };
}

/** Titik pegangan yang tersentuh, 'move' bila di dalam kotak, atau null. */
const activeHandles = () => (state.shape === 'circle' ? HANDLES.filter((h) => h.length === 2) : HANDLES);

function hitBox(p, touch) {
  if (!state.area) return null;
  const r = areaPx();
  const tol = (touch ? 22 : 12) / cssPerPx;
  const pts = handlePoints(r);
  for (const h of activeHandles()) {
    const [x, y] = pts[h];
    if (Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol) return h;
  }
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h ? 'move' : null;
}

/** Ubah kotak dari posisi awal `from` (px) sesuai pegangan dan pergeseran pointer. */
function adjustBox(from, handle, dx, dy) {
  const min = Math.max(24, Math.min(W(), H()) * 0.05);
  let x0 = from.x, y0 = from.y, x1 = from.x + from.w, y1 = from.y + from.h;
  if (handle === 'move') {
    const nx = clamp(x0 + dx, 0, W() - from.w), ny = clamp(y0 + dy, 0, H() - from.h);
    x1 += nx - x0; y1 += ny - y0; x0 = nx; y0 = ny;
  } else {
    if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - min);
    if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + min, W());
    if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - min);
    if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + min, H());
    if (state.shape === 'circle') {
      // Lingkaran tetap bulat: kotak dijaga persegi, ditarik dari sudut seberangnya.
      const side = Math.max(x1 - x0, y1 - y0);
      if (handle.includes('w')) x0 = x1 - side; else x1 = x0 + side;
      if (handle.includes('n')) y0 = y1 - side; else y1 = y0 + side;
    }
  }
  state.box = { x: x0 / W(), y: y0 / H(), w: (x1 - x0) / W(), h: (y1 - y0) / H() };
  areaChanged();
}

/** Ketuk: tambah titik dan hapus warna yang tersambung dengannya. */
async function addSeed(p) {
  const x = clamp(p.x, 0, W() - 1);
  const y = clamp(p.y, 0, H() - 1);
  const before = state.seeds.length ? fillResult() : null;
  if (before?.region[Math.floor(y) * W() + Math.floor(x)]) {
    return toast('Bagian ini sudah termasuk area foto. Ketuk bagian lain yang masih tersisa.');
  }
  pushHistory();
  const seed = { x: x / W(), y: y / H() };
  busy('Memproses…');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  // Toleransi dipilih otomatis agar tidak bocor ke elemen yang warnanya mirip.
  seed.tol = toleranceFor(seed);
  state.seeds = [...state.seeds, seed];
  areaChanged();
  busy(false);
  const res = fillResult();
  if (res.count > W() * H() * 0.6) {
    toast('Pilihan meluas ke sebagian besar bingkai. Urungkan, lalu ketuk bagian lain.', true);
  } else if (res.edge && !before?.edge) {
    toast('Bagian ini menyentuh tepi bingkai, foto bisa ikut muncul di sana. Urungkan bila tidak sesuai.', true);
  }
}

function areaChanged() {
  rebuildFrame();
  if (state.photo && state.area) {
    if (!state.pos) resetPos();
    clampPos();
  }
  updateUI();
  render();
}

/* ================= Foto ================= */

function coverScale() {
  const r = areaPx();
  return Math.max(r.w / state.photo.width, r.h / state.photo.height);
}

function resetPos() {
  const r = areaPx();
  state.pos = { cx: r.x + r.w / 2, cy: r.y + r.h / 2, zoom: 1 };
}

function clampPos() {
  const r = areaPx();
  const { width: w, height: h } = state.photo;
  const p = state.pos;
  p.zoom = clamp(p.zoom, 1, 4);
  const s = coverScale() * p.zoom;
  const hw = (w * s) / 2;
  const hh = (h * s) / 2;
  p.cx = clamp(p.cx, r.x + r.w - hw, r.x + hw);
  p.cy = clamp(p.cy, r.y + r.h - hh, r.y + hh);
}

function zoomAt(zoom, fx, fy) {
  const p = state.pos;
  const next = clamp(zoom, 1, 4);
  const k = next / p.zoom;
  p.cx = fx + (p.cx - fx) * k;
  p.cy = fy + (p.cy - fy) * k;
  p.zoom = next;
  clampPos();
  updateZoomUI();
  render();
}

function zoomCenter(zoom) {
  const r = areaPx();
  zoomAt(zoom, r.x + r.w / 2, r.y + r.h / 2);
}

/* ================= Gambar ================= */

function drawComposite(c, placeholder = false) {
  if (state.area) {
    const r = areaPx();
    c.save();
    // Klip ke lingkaran (mode bulat) atau kotak; sisanya tertutup bingkai di atasnya.
    c.beginPath();
    if (state.shape === 'circle') c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    if (state.photo) {
      const { width: w, height: h } = state.photo;
      const s = coverScale() * state.pos.zoom;
      c.imageSmoothingQuality = 'high';
      c.drawImage(state.photo, state.pos.cx - (w * s) / 2, state.pos.cy - (h * s) / 2, w * s, h * s);
    } else if (placeholder) {
      c.fillStyle = '#fff8e0';
      c.fillRect(r.x, r.y, r.w, r.h);
      c.fillStyle = '#746019';
      c.font = `600 ${Math.max(12, Math.min(r.w, r.h) * 0.075)}px ${getComputedStyle(document.body).fontFamily}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('Ketuk untuk pilih foto', r.x + r.w / 2, r.y + r.h / 2);
    }
    c.restore();
  }
  c.drawImage(state.frame, 0, 0);
}

let viewScale = 1; // piksel kanvas per piksel template
let cssPerPx = 1; // piksel CSS per piksel template

function layoutView() {
  if (!state.source) return;
  // Pratinjau mengisi ruang yang tersisa di layar, rasio bingkai dipertahankan.
  const cs = getComputedStyle(el.stage);
  const wrapW = el.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const wrapH = el.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (wrapW <= 0 || wrapH <= 0) return;
  const k = Math.min(wrapW / W(), wrapH / H());
  const cssW = Math.max(1, Math.floor(W() * k));
  const cssH = Math.max(1, Math.floor(H() * k));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (el.view.style.width === `${cssW}px` && el.view.style.height === `${cssH}px` && el.view.width === Math.round(cssW * dpr)) return;
  el.view.style.width = `${cssW}px`;
  el.view.style.height = `${cssH}px`;
  el.view.width = Math.round(cssW * dpr);
  el.view.height = Math.round(cssH * dpr);
  viewScale = el.view.width / W();
  cssPerPx = cssW / W();
  render();
}

let raf = 0;
function render() {
  if (raf || !state.source) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.view.width, el.view.height);
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    if (state.step === 3) drawComposite(ctx, true);
    else ctx.drawImage(state.frame, 0, 0);
    if (state.step === 2) drawSeeds();
  });
}

/** Titik kuning = tempat yang diketuk; kotak putus-putus = batas foto (bisa ditarik/digeser). */
function drawSeeds() {
  const u = 1 / cssPerPx; // 1 px CSS dalam satuan template
  if (state.area) {
    const r = areaPx();
    ctx.lineWidth = 3.5 * u;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([6 * u, 4 * u]);
    ctx.strokeStyle = '#1c1c1e';
    ctx.lineWidth = 1.75 * u;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (state.shape === 'circle') {
      // Lingkaran di dalam kotak = bentuk lubang foto.
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.setLineDash([]);
      ctx.lineWidth = 4 * u;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.stroke();
      ctx.setLineDash([7 * u, 5 * u]);
      ctx.lineWidth = 2 * u;
      ctx.strokeStyle = '#1c1c1e';
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const pts = handlePoints(r);
    for (const h of activeHandles()) {
      const [x, y] = pts[h];
      ctx.beginPath();
      ctx.arc(x, y, (h.length === 2 ? 7 : 5.5) * u, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2 * u;
      ctx.strokeStyle = '#1c1c1e';
      ctx.stroke();
    }
  }
  for (const s of state.seeds) {
    ctx.beginPath();
    ctx.arc(s.x * W(), s.y * H(), 7 * u, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd02f';
    ctx.fill();
    ctx.lineWidth = 2.5 * u;
    ctx.strokeStyle = '#1c1c1e';
    ctx.stroke();
  }
}

/* ================= Interaksi kanvas ================= */

const pointers = new Map();
let drag = null;

function toTemplate(e) {
  const b = el.view.getBoundingClientRect();
  return { x: ((e.clientX - b.left) / b.width) * W(), y: ((e.clientY - b.top) / b.height) * H() };
}

el.view.addEventListener('pointerdown', (e) => {
  if (!state.source || state.step === 1) return;
  if (e.button !== undefined && e.button > 0) return;
  try { el.view.setPointerCapture(e.pointerId); } catch { /* pointer sudah tidak aktif */ }
  const p = toTemplate(e);
  pointers.set(e.pointerId, p);

  if (state.step === 2) {
    if (pointers.size !== 1) { drag = null; return; }
    const hit = hitBox(p, e.pointerType === 'touch');
    // Pegangan = ubah ukuran; di dalam kotak = ketuk, atau geser kotak bila pointer ditarik.
    drag = { kind: hit && hit !== 'move' ? 'box' : 'tap', handle: hit, start: p, from: state.area && areaPx() };
    return;
  }

  // Langkah 3
  if (!state.photo) return;
  el.stage.classList.add('dragging');
  drag = { kind: 'pan', last: p };
  if (pointers.size === 2) startPinch();
});

el.view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const p = toTemplate(e);
  pointers.set(e.pointerId, p);
  if (!drag) return;

  if (drag.kind === 'tap') {
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * cssPerPx <= 8) return;
    drag.moved = true;
    if (drag.handle !== 'move') return;
    drag.kind = 'box';
  }
  if (drag.kind === 'box') {
    if (!drag.pushed) { pushHistory(); drag.pushed = true; }
    adjustBox(drag.from, drag.handle, p.x - drag.start.x, p.y - drag.start.y);
    return;
  }
  if (pointers.size >= 2 && drag.kind === 'pinch') {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    state.pos.cx += mid.x - drag.mid.x;
    state.pos.cy += mid.y - drag.mid.y;
    drag.mid = mid;
    zoomAt(drag.zoom * (dist / drag.dist), mid.x, mid.y);
    return;
  }
  if (drag.kind === 'pan') {
    state.pos.cx += p.x - drag.last.x;
    state.pos.cy += p.y - drag.last.y;
    drag.last = p;
    clampPos();
    render();
  }
});

function startPinch() {
  const [a, b] = [...pointers.values()];
  drag = {
    kind: 'pinch', zoom: state.pos.zoom,
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (state.step === 2) {
    if (drag?.kind === 'tap' && !drag.moved && e.type === 'pointerup' && pointers.size === 0) addSeed(drag.start);
    if (pointers.size === 0) drag = null;
    return;
  }
  if (state.step === 3) {
    if (pointers.size === 1 && state.photo) drag = { kind: 'pan', last: [...pointers.values()][0] };
    else if (pointers.size === 0) { drag = null; el.stage.classList.remove('dragging'); }
  }
}
// Kursor penunjuk pegangan saat mouse melayang di atas kotak (desktop).
el.view.addEventListener('pointermove', (e) => {
  if (state.step !== 2 || pointers.size || e.pointerType === 'touch') return;
  el.view.style.cursor = CURSORS[hitBox(toTemplate(e), false)] || '';
});
el.view.addEventListener('pointerup', endPointer);
el.view.addEventListener('pointercancel', endPointer);

el.view.addEventListener('click', () => {
  if (state.step === 3 && !state.photo) el.photoInput.click();
});

el.view.addEventListener('wheel', (e) => {
  if (state.step !== 3 || !state.photo) return;
  e.preventDefault();
  const p = toTemplate(e);
  zoomAt(state.pos.zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
}, { passive: false });

/* ================= Keyboard ================= */

el.stage.addEventListener('keydown', (e) => {
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const dir = dirs[e.key];
  // Langkah 2: panah menggeser kotak foto, Shift + panah melebarkan/menyempitkan sisi kanan/bawah.
  if (state.step === 2 && state.area && dir) {
    e.preventDefault();
    pushHistory();
    const step = Math.max(2, Math.min(W(), H()) * 0.01);
    if (e.shiftKey && state.shape === 'circle') adjustBox(areaPx(), 'se', (dir[0] || dir[1]) * step, (dir[0] || dir[1]) * step);
    else if (e.shiftKey) adjustBox(areaPx(), dir[0] ? 'e' : 's', dir[0] * step, dir[1] * step);
    else adjustBox(areaPx(), 'move', dir[0] * step, dir[1] * step);
    return;
  }
  if (state.step !== 3 || !state.source) return;
  if (!state.photo) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.photoInput.click(); }
    return;
  }
  const r = areaPx();
  if (dir) {
    e.preventDefault();
    state.pos.cx -= dir[0] * r.w * 0.02;
    state.pos.cy -= dir[1] * r.h * 0.02;
    clampPos();
    render();
  } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCenter(state.pos.zoom * 1.1); }
  else if (e.key === '-') { e.preventDefault(); zoomCenter(state.pos.zoom / 1.1); }
  else if (e.key === '0') { e.preventDefault(); resetPos(); updateZoomUI(); render(); }
});

/* ================= Berkas ================= */

async function handleFrameFile(file, shared = false) {
  hideToast();
  try {
    checkSize(file, LIMITS.frameBytes, 'Bingkai');
    const kind = await sniff(file);
    if (kind === 'pdf') return await loadPdf(file);
    const accepted = 'PNG, JPG, WebP, AVIF, atau PDF';
    if (!FRAME_IMAGES.includes(kind)) {
      throw new UserError(kind === 'heic'
        ? 'Bingkai HEIC tidak didukung. Ekspor bingkai ke PNG (paling baik, mendukung transparansi) atau JPG.'
        : unsupportedMessage(kind, accepted));
    }
    busy('Membaca bingkai…');
    const canvas = await loadImage(file, kind, { what: 'Bingkai', accepted, maxSide: LIMITS.outSide });
    closePdf();
    setFrame(canvas, { shared });
  } catch (err) {
    fail(err);
  } finally {
    busy(false);
  }
}

async function loadPdf(file) {
  busy('Membuka PDF…');
  const { openPdf, renderPage } = await import('./pdf.js');
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  closePdf();
  state.pdf = doc;
  state.pdfPage = 0;

  if (doc.numPages === 1) return choosePdfPage(1);

  el.pageGrid.replaceChildren();
  el.pdfPages.hidden = false;
  goStep(1);
  busy(false);
  for (let n = 1; n <= doc.numPages; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-thumb';
    btn.dataset.page = n;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', `Halaman ${n}`);
    btn.innerHTML = `<span>Hal. ${n}</span>`;
    btn.addEventListener('click', () => choosePdfPage(n));
    el.pageGrid.append(btn);
  }
  toast(`PDF berisi ${doc.numPages} halaman. Pilih halaman bingkainya.`);
  for (const btn of el.pageGrid.children) {
    if (state.pdf !== doc) return;
    try {
      const thumb = await renderPage(doc, Number(btn.dataset.page), 160);
      btn.prepend(thumb);
    } catch { /* thumbnail opsional */ }
  }
}

async function choosePdfPage(n) {
  if (!state.pdf) return;
  if (state.pdfPage && n !== state.pdfPage && state.history.length
      && !window.confirm('Ganti halaman akan mereset area foto yang sudah diatur. Lanjutkan?')) return;
  try {
    busy(`Merender halaman ${n}…`);
    const { renderPage } = await import('./pdf.js');
    const canvas = await renderPage(state.pdf, n, LIMITS.outSide);
    state.pdfPage = n;
    for (const b of el.pageGrid.children) b.setAttribute('aria-pressed', String(Number(b.dataset.page) === n));
    setFrame(canvas);
  } catch (err) {
    fail(err instanceof UserError ? err : new UserError('Halaman PDF gagal dirender. Coba halaman lain atau ekspor bingkai ke PNG.'));
  } finally {
    busy(false);
  }
}

function closePdf() {
  if (state.pdf) state.pdf.destroy();
  state.pdf = null;
  state.pdfPage = 0;
  el.pdfPages.hidden = true;
  el.pageGrid.replaceChildren();
}

async function handlePhotoFile(file) {
  hideToast();
  try {
    checkSize(file, LIMITS.photoBytes, 'Foto');
    const kind = await sniff(file);
    const accepted = 'foto JPG, PNG, WebP, atau HEIC';
    if (!PHOTO_IMAGES.includes(kind)) throw new UserError(unsupportedMessage(kind, accepted));
    busy('Menyiapkan foto…');
    setPhoto(await loadImage(file, kind, { what: 'Foto', accepted, maxSide: LIMITS.photoSide }));
  } catch (err) {
    fail(err);
  } finally {
    busy(false);
  }
}

function setPhoto(canvas) {
  state.photo = canvas;
  resetPos();
  el.openFallback.hidden = true;
  if (state.step !== 3) goStep(3);
  updateUI();
  render();
}

/* ================= Ekspor ================= */

function renderResult() {
  const c = document.createElement('canvas');
  c.width = W();
  c.height = H();
  const cx = c.getContext('2d');
  if (!cx) throw new UserError('Memori perangkat tidak cukup. Tutup tab lain lalu coba lagi.');
  drawComposite(cx);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new UserError('Memori perangkat tidak cukup untuk membuat gambar. Tutup tab lain atau pakai foto yang lebih kecil.'))), 'image/png');
  });
}

function saveBlob(blob, name) {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  const url = URL.createObjectURL(blob);
  state.resultUrl = url;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  el.openLink.href = url;
  el.openFallback.hidden = false;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

async function download() {
  if (!state.photo) return;
  try {
    busy('Membuat PNG…');
    saveBlob(await renderResult(), `twibbon-${stamp()}.png`);
    toast(`Twibbon tersimpan (${W()} × ${H()} px).`);
  } catch (err) {
    fail(err);
  } finally {
    busy(false);
  }
}

async function share() {
  try {
    busy('Menyiapkan…');
    const file = new File([await renderResult()], `twibbon-${stamp()}.png`, { type: 'image/png' });
    busy(false);
    await navigator.share({ files: [file] });
  } catch (err) {
    busy(false);
    if (err?.name !== 'AbortError') fail(err);
  }
}

/* ================= UI ================= */

function hintText() {
  if (state.step === 1) return 'Bingkai dimuat. Lanjut ke langkah Area foto.';
  if (state.step === 3) return state.photo ? 'Geser foto untuk mengatur posisi.' : 'Ketuk area foto atau tombol Pilih foto.';
  if (!state.area) return 'Ketuk bagian putih tempat foto akan muncul.';
  if (state.detected && !state.history.length) {
    return state.shape === 'circle'
      ? 'Lubang bulat terdeteksi. Tarik sudut kotak bila lingkarannya kurang pas.'
      : 'Area terdeteksi otomatis. Tarik titik kotak bila kurang pas.';
  }
  return 'Ketuk sisa putih, atau tarik titik kotak untuk merapikan area foto.';
}

function goStep(n) {
  if (n > 1 && !state.source) return;
  if (n === 3 && !state.area) return;
  state.step = n;
  $$('.pane').forEach((p) => { p.hidden = Number(p.dataset.pane) !== n; });
  el.stage.classList.toggle('mode-area', n === 2);
  el.stage.classList.toggle('mode-photo', n === 3);
  el.photoControls.hidden = n !== 3;
  el.stage.setAttribute('aria-label', n === 2
    ? 'Editor area foto. Ketuk bagian putih untuk menjadikannya tempat foto. Panah menggeser kotak foto, Shift dan panah mengubah ukurannya.'
    : n === 3 ? 'Pratinjau Twibbon. Panah untuk menggeser foto, plus dan minus untuk zoom.' : 'Pratinjau bingkai');
  drag = null;
  pointers.clear();
  updateUI();
  render();
}

function updateZoomUI() {
  const z = state.pos ? state.pos.zoom : 1;
  el.zoom.value = String(z);
  el.zoomVal.textContent = `${Math.round(z * 100)}%`;
  el.zoomIn.disabled = !state.photo || z >= 4;
  el.zoomOut.disabled = !state.photo || z <= 1;
}

function updateUI() {
  $$('.step').forEach((b) => {
    const s = Number(b.dataset.step);
    b.disabled = (s > 1 && !state.source) || (s === 3 && !state.area);
    if (s === state.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.classList.toggle('done', !!state.source && s < state.step);
  });
  if (!state.source) { el.hint.textContent = ''; return; }
  const hasPhoto = !!state.photo;
  el.hint.textContent = hintText();
  el.undo.disabled = state.history.length === 0;
  el.toPhoto.disabled = !state.area;
  $$('[data-shape]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.shape === state.shape)));
  $('#photoBtn').textContent = hasPhoto ? 'Ganti foto' : 'Pilih foto';
  el.zoom.disabled = !hasPhoto;
  el.resetPos.disabled = !hasPhoto;
  el.download.disabled = !hasPhoto;
  el.share.disabled = !hasPhoto;
  updateZoomUI();
}

let busyCount = 0;
function busy(text) {
  if (text === false) {
    busyCount = Math.max(0, busyCount - 1);
    if (!busyCount) el.busy.hidden = true;
    return;
  }
  busyCount++;
  el.busyText.textContent = text;
  el.busy.hidden = false;
}

let toastTimer = 0;
function toast(msg, error = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('error', error);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, error ? 9000 : 4500);
}
function hideToast() { el.toast.hidden = true; }

function fail(err) {
  if (err instanceof UserError) return toast(err.message, true);
  console.error('Auto Twibbon gagal:', err?.name || 'Error');
  const oom = err?.name === 'RangeError' || /memory/i.test(String(err?.message));
  toast(oom
    ? 'Memori perangkat tidak cukup. Tutup tab lain atau pakai berkas yang lebih kecil.'
    : 'Terjadi kesalahan saat memproses. Muat ulang halaman lalu coba lagi.', true);
}

/* ================= Event ================= */

el.frameInput.addEventListener('change', () => {
  const f = el.frameInput.files[0];
  el.frameInput.value = '';
  if (f) handleFrameFile(f);
});
el.photoInput.addEventListener('change', () => {
  const f = el.photoInput.files[0];
  el.photoInput.value = '';
  if (f) handlePhotoFile(f);
});

// Tempel (Ctrl+V) & tarik-lepas: langkah 3 menerima foto, langkah lain menerima bingkai.
const takeFile = (f) => (state.step === 3 ? handlePhotoFile(f) : handleFrameFile(f));

document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find((i) => i.kind === 'file' && (i.type.startsWith('image/') || i.type === 'application/pdf'));
  if (!item) {
    if (items.some((i) => i.kind === 'string')) toast('Clipboard tidak berisi gambar. Salin gambarnya (bukan link-nya), lalu tempel lagi.', true);
    return;
  }
  e.preventDefault();
  const f = item.getAsFile();
  if (f) takeFile(f);
});

$$('.step').forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.step))));
el.toPhoto.addEventListener('click', () => goStep(3));
el.undo.addEventListener('click', undo);
$$('[data-shape]').forEach((b) => b.addEventListener('click', () => setShape(b.dataset.shape)));
el.resetArea.addEventListener('click', resetArea);

el.zoom.addEventListener('input', () => state.photo && zoomCenter(Number(el.zoom.value)));
el.zoomIn.addEventListener('click', () => zoomCenter(state.pos.zoom * 1.15));
el.zoomOut.addEventListener('click', () => zoomCenter(state.pos.zoom / 1.15));
el.resetPos.addEventListener('click', () => { resetPos(); updateZoomUI(); render(); });
el.download.addEventListener('click', download);
el.share.addEventListener('click', share);

// Bagikan berkas hanya muncul di perangkat yang mendukung (umumnya HP).
try {
  const probe = new File([new Blob()], 'x.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [probe] }) && matchMedia('(pointer: coarse)').matches) el.share.hidden = false;
} catch { /* tidak didukung */ }

['dragenter', 'dragover'].forEach((t) => el.stage.addEventListener(t, (e) => {
  e.preventDefault();
  el.stage.classList.add('drag-over');
}));
['dragleave', 'drop'].forEach((t) => el.stage.addEventListener(t, (e) => {
  e.preventDefault();
  if (t === 'dragleave' && el.stage.contains(e.relatedTarget)) return;
  el.stage.classList.remove('drag-over');
}));
el.stage.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) takeFile(f);
});

new ResizeObserver(layoutView).observe(el.stage);

// Template bersama: ?t=nama memuat /templates/nama.png (taruh berkasnya di folder public/templates).
const shared = new URLSearchParams(location.search).get('t');
if (shared) {
  if (/^[\w-]{1,64}$/.test(shared)) {
    busy('Memuat template…');
    fetch(`/templates/${shared}.png`)
      .then((res) => {
        if (!res.ok || !(res.headers.get('content-type') || '').includes('png')) throw new UserError('Template tidak ditemukan atau sudah tidak aktif. Minta tautan terbaru ke pembuat acara.');
        return res.blob();
      })
      .then((b) => handleFrameFile(new File([b], `${shared}.png`, { type: 'image/png' }), true))
      .catch(fail)
      .finally(() => busy(false));
  } else {
    toast('Tautan template tidak valid.', true);
  }
}

goStep(1);

// Hanya untuk debugging lokal; tidak ikut ke build produksi.
if (import.meta.env.DEV) window.__twibbon = { state, areaChanged, render };
