# Auto Twibbon

Web satu halaman untuk mengubah bingkai gambar (PNG, JPG, WebP, AVIF) atau PDF menjadi Twibbon. Semua proses (bingkai, foto, ekspor) terjadi di browser; tidak ada backend dan tidak ada foto yang dikirim ke server.

Desain mengikuti [`DESIGN.md`](DESIGN.md) (Miro, dari [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)): kanvas putih, aksen kuning, tombol pill.

## Alur

1. **Bingkai**: unggah PNG, JPG, WebP, AVIF, atau PDF (maks. 20 MB, PDF maks. 20 halaman, pilih satu halaman). PNG/WebP transparan tetap dipertahankan; bingkai JPG dilubangi lewat ketuk warna.
2. **Area foto** (ketuk warna): ketuk bagian polos (mis. putih). Hanya warna yang tersambung yang dihapus, jadi tulisan/ornamen yang menimpa area foto tetap utuh. Toleransi warna dipilih otomatis per ketukan, sehingga elemen yang warnanya mirip (mis. kertas atau label abu-abu muda) tidak ikut terhapus. Ketuk lagi untuk sisa yang terkurung huruf. Bentuk area **Bulat** atau **Kotak** dipilih otomatis: bila tepi lubang cocok dengan lingkaran (walau sebagian tertutup logo), dipakai lingkaran di dalam kotak; warna lubang hanya dihapus di dalam lingkaran dan foto dipotong bulat, jadi warna yang tersambung ke luar (gelombang, garis logo) tidak ikut bolong. Lubang lain (kotak, sobekan kertas) memakai kotak. Bentuk bisa diganti manual. Kotak putus-putus (batas foto) dibuat otomatis tanpa ikut celah tipis, dan bisa dirapikan: tarik titik sudut/sisi untuk mengubah ukuran, tarik bagian dalam untuk menggeser (keyboard: panah / Shift+panah). Ada urungkan dan reset.

   Otomatis: bingkai yang lubangnya sudah transparan (PNG/WebP) dipakai apa adanya tanpa diedit dan langsung masuk ke langkah foto. Bila belum transparan, area polos di tengah bingkai langsung dipilih; tepinya dirapikan (sisa putih 1 px dibuang dan pinggiran dihaluskan) supaya tidak berbintik atau bergerigi.
3. **Foto & unduh**: foto mengisi area (cover), bisa digeser, dicubit/scroll untuk zoom, lalu diunduh sebagai PNG dengan ukuran template.

Di desktop, bingkai dan foto juga bisa ditempel dari clipboard (Ctrl+V / ⌘V). Di langkah foto, gambar yang ditempel menjadi foto; di langkah lain menjadi bingkai.

Tampilan dibuat satu layar penuh tanpa scroll, baik di HP (tegak maupun mendatar) maupun desktop.

## Berbagi template (pengganti tautan acara)

Tanpa backend, bingkai dibagikan lewat folder `public/templates`:

- Taruh bingkai PNG di `public/templates/<nama>.png`, deploy, lalu bagikan `https://domainmu/?t=<nama>`. Nama hanya boleh huruf, angka, `-`, dan `_`.
- Bila lubang transparan atau area putih di tengah terdeteksi, peserta langsung masuk ke langkah foto. Paling aman pakai PNG yang lubangnya sudah transparan.
- Untuk menonaktifkan, hapus berkasnya lalu deploy ulang.

## Menjalankan

```bash
npm install
```

```bash
npm run dev
```

## Deploy ke Vercel

Impor repo di Vercel. Framework terdeteksi sebagai Vite (build `npm run build`, output `dist`). Tidak ada environment variable yang perlu diisi.

## Batasan (sesuai PRD, disesuaikan tanpa backend)

| Parameter | Batas |
| --- | --- |
| Bingkai PNG/JPG/WebP/AVIF/PDF | 20 MB, 24 MP setelah decoding |
| Halaman PDF | 20 |
| Foto JPG/PNG/WebP/AVIF/GIF/BMP/HEIC | 15 MB, 24 MP setelah decoding |
| Keluaran | Sisi terpanjang maks. 2.000 px; PNG kecil tidak diperbesar |

- HEIC dan AVIF dibaca oleh browser sendiri: HEIC jalan di Safari (iOS/macOS); di browser lain muncul pesan untuk mengubah ke JPG. GIF hanya frame pertama. SVG sengaja tidak didukung.
- Fitur PRD yang butuh server (login, draft/publikasi, kepemilikan acara) diganti oleh template PNG + `?t=`.
- Halaman awal sekitar 26 KB dalam 3 request: HTML (CSS sudah ditanam di dalamnya), JS ~10 KB, dan font ~10 KB yang di-preload. pdf.js hanya diunduh saat pengguna membuka PDF.
- Font `src/fonts/plus-jakarta-sans.woff2` adalah Plus Jakarta Sans (OFL, lihat `src/fonts/OFL.txt`) yang dipangkas ke huruf Latin dasar + `· × … › −` dan ketebalan 400–600. Kalau UI memakai karakter atau ketebalan baru, buat ulang subset-nya dengan fonttools (`varLib.instancer` lalu `pyftsubset`).
