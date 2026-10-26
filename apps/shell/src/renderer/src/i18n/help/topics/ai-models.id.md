# Model AI dan pengaturan

## Penyedia dan model

Model dan kunci dikonfigurasi di Pengaturan (baris akun di kiri bawah Beranda):

![Jendela Pengaturan](img/settings-general.png)

- **Claude (langganan)** (default): memakai login CLI `claude` lokal Anda — jalankan `claude login` sekali; model sonnet, opus, haiku; hanya teks, tanpa gambar. **Codex CLI** juga didukung, dan server lokal seperti Ollama atau LM Studio berfungsi sebagai endpoint kustom yang kompatibel dengan OpenAI.
- **Pencarian web dan media**: pencarian web berjalan tanpa kunci (rantai gratis; penyedia berkunci bersifat opsional). Pembuatan gambar dan analisis media tetap nonaktif sampai penyedia AI Media dikonfigurasi.
- **Endpoint kustom (BYOK)**: Pengaturan ▸ AI menerima base URL dan kunci API untuk tiap protokol — yang kompatibel dengan OpenAI, Anthropic, Gemini, DeepSeek, DashScope (qwen), dan lainnya. Kunci disimpan di berkas pengaturan aplikasi pada mesin ini dan hanya dikirim di header permintaan. Atlas Cloud termasuk protokol bawaan.
- Model berbeda dapat dipilih per kemampuan: obrolan/pembuatan, pembuatan gambar, analisis gambar.
- **Uji koneksi**: memastikan endpoint dapat dijangkau dan model terlihat sebelum disimpan.
- Base URL boleh memuat path dan query string (gaya gateway); path endpoint akan ditambahkan dengan benar.

## Integrasi CLI (semacam Codex)

- Pengaturan menerima path program CLI lokal (direktori beranda non-ASCII dan awalan ~ berfungsi; ~ dikembangkan otomatis); Deteksi otomatis akan memeriksa model yang tersedia pada CLI tersebut.
- Validasi hanya memeriksa keberadaan berkas — tidak ada pembatasan karakter.

## Kapan perubahan berlaku

- Perubahan model dan endpoint berlaku seketika; percakapan yang sedang berjalan memakai konfigurasi lama sampai putaran berikutnya.
