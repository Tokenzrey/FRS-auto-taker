# FRS Auto-Taker

Bot otomasi pengambilan kelas FRS dengan prioritas, pusat CAPTCHA, dan Notify Extended (monitor kenaikan kuota) untuk membantu Anda mengambil kelas lebih cepat dan efisien.

## Ringkasan

Ekstensi ini berjalan pada halaman FRS `list_frs.php` dan menyediakan:

- Parsing kelas otomatis sedini mungkin (Early DOM Sniffer) saat opsi muncul.
- UI popup untuk memilih prioritas kelas dan memulai proses “hunting”.
- Alur CAPTCHA terpusat (preview, refresh, submit) agar cepat dan praktis.
- Notify Extended untuk memantau kenaikan kuota kelas prioritas secara berkala; ketika ada kenaikan kuota, tampilkan overlay + suara dan otomatis beralih ke mode hunting untuk kandidat prioritas teratas.

## Fitur utama

- Early DOM Sniffer: mendeteksi dan mem-parsing opsi kelas segera setelah tersedia (tanpa menunggu render selesai), sehingga data kelas siap lebih cepat.
- Manajemen Prioritas: tarik dan lepas (drag & drop) kelas dari daftar “Semua Kelas” ke daftar “Prioritas”.
- Mode Hunting: mencoba ambil kelas satu per satu sesuai urutan prioritas. Menangani evaluasi setelah reload dan melanjutkan ke kandidat berikutnya.
- Pusat CAPTCHA: popup menampilkan gambar CAPTCHA (snapshot data URL), tombol refresh, dan input untuk submit yang terhubung langsung ke tab halaman FRS.
- Notify Extended: saat diaktifkan pada kondisi Idle, ekstensi melakukan reload halaman secara periodik, membandingkan baseline kuota untuk hanya kelas prioritas, dan memberi tahu jika ada kelas yang kuotanya bertambah. Ekstensi akan memainkan suara, menampilkan overlay, mematikan mode notify, dan otomatis memulai hunting pada kandidat prioritas yang terdeteksi.
- Opsi yang dapat disetel: jumlah maksimal percobaan CAPTCHA, dan interval reload untuk Notify Extended.

## Cara kerja singkat

- Content script (`content.js`) berjalan pada `document_start` (lihat manifest) agar bisa menangkap opsi yang dimuat cepat melalui Early DOM Sniffer, lalu menyimpan hasil parsing kelas di `chrome.storage.local`.
- Background service worker (`background.js`) menjadi pusat state dan menerima pesan dari popup dan content script (misalnya NOTIFY, NEED_CAPTCHA, dsb.).
- Popup (`popup.html`/`popup.js`) menampilkan UI untuk setup, prioritas, status notify, dan alur hunting & CAPTCHA.

## Instalasi

1. Persyaratan

- Browser berbasis Chromium (Chrome, Edge, Brave, dsb.).

2. Muat sebagai ekstensi unpacked

- Buka chrome://extensions (atau edge://extensions).
- Aktifkan Developer mode.
- Klik “Load unpacked” dan pilih folder `frs-auto-taker` yang berisi file manifest.json.

3. Izin yang diminta

- `storage`, `tabs`, `notifications` untuk penyimpanan state, interaksi tab aktif, dan notifikasi.
- `host_permissions`: `*://*/list_frs.php*`, `*://*/securimage/*` agar script bisa berjalan di halaman FRS dan memuat captcha.

## Setup awal

1. Buka halaman target FRS: URL yang mengandung `list_frs.php`.
2. Klik icon ekstensi untuk membuka popup.
3. Buka halaman Options (tautan di popup) untuk set:
   - Max CAPTCHA Attempts: jumlah maksimal percobaan sebelum kandidat dilompati.
   - Notify Extended interval (detik): interval reload saat pemantauan.

Catatan: Parsing kelas berjalan otomatis dan sangat dini (Early DOM Sniffer). Jika data belum terlihat di popup, klik tombol “Refresh” di popup setelah halaman FRS memuat semua opsi.

## Penggunaan end-to-end

### A. Menyusun Prioritas

1. Di popup, gunakan kotak pencarian untuk memfilter kelas.
2. Tarik item dari “Semua Kelas” ke daftar “Prioritas”. Urutan di daftar ini menentukan urutan percobaan pengambilan.
3. Anda bisa menghapus semua prioritas dengan tombol “Clear”.

### B. Memulai Hunting

1. Pastikan halaman `list_frs.php` terbuka dan siap.
2. Di popup, klik tombol “Start”. Status dot akan berubah menjadi “hunting”.
3. Content script akan memilih kandidat prioritas pertama, menyiapkan form, dan meminta CAPTCHA melalui popup.
4. Masukkan CAPTCHA di popup, tekan Enter atau klik “Kirim”.
5. Ekstensi mengirim form. Setelah reload halaman, ekstensi mengevaluasi apakah kelas berhasil diambil:
   - Jika berhasil: menampilkan notifikasi “Berhasil”, mengosongkan pending, dan melanjutkan ke kandidat berikutnya.
   - Jika gagal karena penuh: menampilkan notifikasi dan otomatis melanjutkan ke kandidat berikutnya.
   - Jika gagal karena CAPTCHA: akan melakukan backoff dan mencoba ulang kandidat yang sama sampai batas maksimal percobaan (Max CAPTCHA Attempts).
6. Anda bisa menghentikan hunting kapan saja dengan tombol “Stop”.

Tips CAPTCHA:

- Popup menampilkan snapshot CAPTCHA (data URL) dan tombol “Refresh” untuk memuat ulang. Snapshot menghindari request ulang tidak perlu dan mempercepat proses.

### C. Notify Extended (Pemantauan Kenaikan Kuota)

1. Hanya dapat diaktifkan saat mode “Idle”. Pastikan tidak sedang hunting.
2. Aktifkan toggle “Notify Extended” di popup.
3. Ekstensi akan:
   - Mem-build baseline kuota untuk kelas yang ada di daftar “Prioritas”.
   - Reload halaman FRS per interval (dari Options) dan parsing kelas terbaru.
   - Membandingkan baseline vs kondisi sekarang untuk mendeteksi kenaikan kuota.
4. Jika terdeteksi kenaikan kuota:
   - Muncul overlay merah informatif di halaman dengan daftar kelas yang “extend” berikut delta kuotanya.
   - Suara beep singkat akan diputar.
   - Ekstensi mematikan mode notify dan otomatis berpindah ke mode hunting pada kandidat prioritas teratas yang kuotanya naik.
5. Jika tidak ada kenaikan kuota, baseline diperbarui agar perbandingan tetap akurat pada siklus berikutnya.

### D. Refresh Data Kelas secara Manual

- Di popup, klik tombol “Refresh” untuk memaksa mengambil data kelas terbaru dari halaman saat ini.

## Opsi dan perilaku penting

- Max CAPTCHA Attempts: default 8. Ketika mencapai batas, kandidat dilompati.
- Backoff antara percobaan CAPTCHA: default 3000 ms.
- Notify Extended interval: dapat diatur (disarankan 15–60 detik). Interval yang terlalu pendek dapat membuat reload terlalu sering.
- Early DOM Sniffer: mengamati DOM sedini mungkin untuk menangkap opsi begitu muncul dan menyimpan hasil ke storage, sehingga popup mendapat data lebih cepat.

## Troubleshooting

- Popup tidak menampilkan kelas:

  - Pastikan URL halaman mengandung `list_frs.php` dan opsi kelas sudah tersedia.
  - Klik tombol “Refresh” di popup setelah halaman memuat semua filter/opsi.
  - Cek Console (DevTools) pada tab halaman FRS jika ada error.

- Notify Extended tidak bisa dinyalakan:

  - Hanya bisa saat mode “Idle”. Klik “Stop” untuk keluar dari hunting.
  - Pastikan ada kelas di daftar “Prioritas”; baseline hanya dibuat dari prioritas.

- CAPTCHA tidak muncul di popup:

  - Pastikan gambar captcha tersedia di halaman; coba tombol “Refresh” di popup.
  - Periksa izin host `*://*/securimage/*` sudah sesuai domain kampus Anda.

- Form FRS berubah/elemen tidak ditemukan:
  - Ekstensi akan menampilkan peringatan jika struktur form berubah. Jika ini terjadi, perlu penyesuaian selector pada kode.

## Privasi dan penyimpanan data

Ekstensi menggunakan `chrome.storage.local` untuk menyimpan:

- Daftar kelas yang ter-parsing, prioritas, status hunting, pending action, dan metadata CAPTCHA terakhir (URL, snapshot, tabId, timestamp).
  Data hanya tersimpan lokal di browser Anda dan tidak dikirim ke pihak ketiga oleh ekstensi ini.

## Dukung halaman/URL

- Content script hanya berjalan di URL yang cocok dengan `*://*/list_frs.php*` (lihat `manifest.json`). Jika kampus Anda menggunakan path yang berbeda, sesuaikan host permission & matches di manifest.

## Catatan pengembangan

- Manifest V3, content script `run_at: document_start` untuk menangkap DOM sedini mungkin.
- Early DOM Sniffer berada di `content.js` dan akan menyimpan hasil parsing ke storage di key `classes`.
- Background sebagai pusat message bus dan state tambahan (notify timestamps, last captcha, dsb.).
- Popup adalah antarmuka utama pengguna untuk seluruh fitur.

## Lisensi

Gunakan secara bertanggung jawab sesuai kebijakan kampus/instansi masing-masing. Tidak ada jaminan fungsionalitas; gunakan atas risiko sendiri.
