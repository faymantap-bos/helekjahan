# AllFetch

Website all-in-one downloader untuk URL publik TikTok, Instagram, Facebook, dan YouTube.

## Menjalankan

Memerlukan Node.js 20 atau lebih baru.

```bash
npm start
```

Lalu buka `http://127.0.0.1:3000`.

Tidak ada dependensi npm yang perlu dipasang. Untuk mode pengembangan dengan auto-reload:

```bash
npm run dev
```

## Catatan

- Extractor saat ini menggunakan layanan pihak ketiga yang dipanggil dari `aio.js`. Jika layanan tersebut mengubah endpoint atau kunci akses, extractor perlu diperbarui.
- Hanya URL dari domain TikTok, Instagram, Facebook, dan YouTube yang diterima.
- Gunakan hanya untuk konten milik sendiri, domain publik, atau konten yang telah diizinkan untuk diunduh.
- Konten privat, konten yang memerlukan login, dan DRM tidak didukung.
