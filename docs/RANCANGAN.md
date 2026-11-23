# Cella — Rancangan v1

Tanggal: 23 November 2026. Status: rancangan, belum ada kode.

Cella adalah kolam terlindung (shielded pool) di Robinhood Chain. ETH masuk dan keluar terlihat di chain; perpindahan di dalam tidak terlihat siapa pun kecuali pemegang kunci auditor. Tidak ada server yang memegang buku besar, dan tidak ada pihak yang bisa memindahkan dana orang lain.

## 1. Apa yang dijanjikan, dan apa yang tidak

| Janji | Dijaga oleh |
|---|---|
| Dana hanya bisa dipakai pemilik kunci catatannya | Bukti ZK yang diperiksa kontrak |
| Tidak ada uang yang tercipta atau hilang di dalam | Aturan jumlah di sirkuit: masuk = keluar |
| Operator tidak bisa melihat transfer | Catatan hanya berupa komitmen terenkripsi di chain |
| Operator tidak bisa menahan dana | Siapa pun bisa mengirim transaksinya sendiri tanpa relayer |
| Auditor bisa membaca semua transfer | Sirkuit menolak transaksi yang sandi auditornya salah |
| Auditor tidak bisa memindahkan dana | Kunci auditor hanya kunci baca |

Yang tidak dijanjikan:

- Setoran dan penarikan tetap publik: alamat wallet dan jumlahnya tercatat di chain.
- Privasi lemah selama pengguna masih sedikit. Bila hanya tiga orang menyetor, pengamat bisa menebak siapa menarik dari jumlah dan waktunya.
- Auditor melihat semuanya. Privasi terhadap auditor tidak ada; itu memang tujuannya.
- Kesalahan di sirkuit atau kontrak bisa menghabiskan seluruh kolam. Tes sendiri tidak cukup; audit luar wajib sebelum dana nyata.

## 2. Perbandingan dengan Adytum

| | Adytum | Cella |
|---|---|---|
| Buku besar | Di server sequencer | Tidak ada; komitmen di chain |
| Saldo dicek di chain | Tidak | Ya, lewat bukti ZK |
| Operator melihat transfer | Ya | Tidak |
| Bila server mati | Exit darurat, transfer terakhir batal | Tidak berpengaruh |
| Transfer di dalam | Gratis, di luar chain | Satu transaksi di chain, taksiran 0,00002–0,00003 ETH |
| Auditor | Sandi dibuat sequencer | Sandi dipaksa benar oleh sirkuit |

## 3. Bagian-bagian

| Bagian | Tempat | Tugas |
|---|---|---|
| `CellaPool` | Kontrak di chain | Menyimpan ETH, pohon komitmen, daftar nullifier; memeriksa bukti |
| `Verifier` | Kontrak di chain | Hasil keluaran alat ZK; memeriksa satu bukti |
| Sirkuit `transact` | Dijalankan di browser pengguna | Membuat bukti untuk setor, transfer, dan tarik |
| App web | Situs statis | Wallet, memindai catatan, membuat bukti |
| Relayer | Server kecil, opsional | Mengirim transaksi dan membayar gas agar alamat pengirim tidak terlihat |
| Alat auditor | Program di komputer auditor | Membuka sandi auditor dari event chain |

Tidak ada basis data. Semua yang dibutuhkan untuk memulihkan saldo ada di event chain dan bisa dibuka dengan kunci pengguna.

## 4. Kunci dan alamat

Pengguna menandatangani satu pesan tetap di wallet-nya. Dari tanda tangan itu diturunkan:

- **Kunci belanja `sk`**: angka rahasia. Kunci publiknya `pk = Poseidon(sk)`.
- **Kunci sandi**: pasangan X25519 untuk menerima catatan.

Alamat Cella seseorang adalah `(pk, kunciSandiPublik)`. Kontrak kecil `Registry` memetakan alamat 0x ke alamat Cella, supaya pengirim cukup mengetik alamat 0x penerima.

Catatan: beberapa wallet menghasilkan tanda tangan berbeda untuk pesan yang sama. App harus menguji ini saat pertama masuk dan menolak wallet yang tidak konsisten, karena kunci yang tidak bisa diturunkan ulang berarti dana tidak bisa dipulihkan.

## 5. Catatan, komitmen, nullifier

- **Catatan** = `(jumlah, pk pemilik, pengacak)`.
- **Komitmen** = `Poseidon(jumlah, pk, pengacak)`. Ini yang masuk ke pohon di chain.
- **Nullifier** = `Poseidon(komitmen, posisi di pohon, sk)`. Diumumkan saat catatan dipakai; kontrak menolak nullifier yang sudah pernah muncul.
- **Pohon**: Merkle inkremental, kedalaman 24 (sekitar 16 juta catatan), hash Poseidon. Kontrak menyimpan 100 akar terakhir.

## 6. Satu sirkuit untuk tiga tindakan

Sirkuit `transact` memakai 2 catatan masuk dan menghasilkan 2 catatan keluar, dengan satu angka publik `jumlahLuar`:

| Tindakan | `jumlahLuar` | Yang terlihat di chain |
|---|---|---|
| Setor | positif | Alamat penyetor dan jumlah |
| Transfer | nol | Dua nullifier, dua komitmen, sandi |
| Tarik | negatif | Alamat penerima dan jumlah |

Satu sirkuit berarti satu hal yang harus diaudit, bukan tiga.

Yang dibuktikan sirkuit:

1. Tiap catatan masuk ada di pohon dengan akar yang diumumkan, atau jumlahnya nol (catatan kosong).
2. Pembuat bukti tahu `sk` pemilik tiap catatan masuk.
3. Nullifier dihitung dengan benar, dan dua nullifier tidak sama.
4. `jumlah masuk + jumlahLuar = jumlah keluar + biaya relayer`.
5. Tiap jumlah berada di antara 0 dan 2^96, supaya tidak bisa berputar di batas bilangan.
6. Sandi auditor memang berisi pk pengirim, pk penerima, dan jumlah tiap catatan keluar.
7. Bukti terikat pada `hashDataLuar`: alamat penerima tarik, alamat relayer, biaya, sandi catatan, chain ID, dan alamat kontrak. Relayer tidak bisa mengubah satu pun.

## 7. Auditor

- Kunci auditor adalah kunci publik BabyJubJub yang tersimpan di kontrak.
- Di dalam sirkuit: kunci sekali pakai `r`, titik `R = r·G` diumumkan, rahasia bersama `r·A`, lalu tiap nilai disandikan dengan aliran Poseidon. Karena ini bagian dari bukti, pengirim tidak bisa mengisi sandi auditor dengan sampah.
- Mengganti kunci auditor: hanya pemilik kontrak, dengan jeda 7 hari yang terlihat publik. Transaksi lama tetap hanya bisa dibaca kunci lama.
- Auditor membaca: siapa (pk) mengirim berapa ke siapa (pk). Hubungan pk ke orang nyata didapat dari setoran, penarikan, dan `Registry`.

## 8. Relayer

- Pengguna menyerahkan bukti ke relayer; relayer mengirim transaksi dan mengambil biaya dari catatan, sejumlah yang tertulis di bukti.
- Relayer hanya bisa menolak melayani. Ia tidak bisa mengubah penerima, jumlah, atau biaya.
- Tanpa relayer, pengguna mengirim sendiri. Yang hilang hanya kerahasiaan alamat pembayar gas untuk transaksi itu.
- Relayer melihat alamat IP pengguna. Ini kebocoran yang diakui.

## 9. Kuasa pemilik kontrak

Kontrak tidak bisa di-upgrade. Pemilik hanya bisa:

| Kuasa | Batas |
|---|---|
| Mengganti kunci auditor | Jeda 7 hari |
| Menghentikan setoran baru | Penarikan dan transfer tidak pernah bisa dihentikan |
| Mengubah batas setoran | Tidak menyentuh dana yang sudah masuk |

Tidak ada fungsi yang memindahkan ETH tanpa bukti yang sah.

## 10. Sistem bukti

Dua pilihan:

| | Groth16 | PLONK |
|---|---|---|
| Upacara kunci khusus | Perlu, per sirkuit | Tidak perlu; memakai upacara publik yang sudah ada |
| Risiko upacara | Bila semua peserta bersekongkol, bukti palsu bisa dibuat dan kolam dikuras | Bergantung pada upacara publik berpeserta banyak |
| Waktu bukti di browser | Lebih cepat | Lebih lambat |
| Gas verifikasi | Lebih kecil | Lebih besar, masih murah di chain ini |

Pilihan awal adalah PLONK, karena upacara yang dijalankan satu tim kecil adalah titik percaya yang justru ingin dihapus. Pengukuran tahap 1 (bagian 16) menunjukkan PLONK terlalu berat untuk browser: 23 detik dan kunci 258 MB di laptop, dibanding 1,6 detik dan 19 MB untuk Groth16.

Usulan setelah pengukuran: **Groth16 dengan upacara terbuka**. Siapa pun boleh ikut menyumbang, dan hasil akhirnya dikunci dengan angka acak publik. Kunci aman selama satu saja penyumbang jujur dan membuang rahasianya. Disetujui pemilik pada 23 November 2026. Upacara harus selesai sebelum tahap 8; sampai saat itu semua tes memakai kunci uji lokal.

## 11. Data chain (diuji 23 November 2026)

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| RPC publik | `rpc.mainnet.chain.robinhood.com` | `rpc.testnet.chain.robinhood.com` |
| Mesin | Arbitrum Nitro v3.13 | Arbitrum Nitro v3.13 |
| Precompile pairing bn254 | Benar pada uji sah dan tidak sah | Benar pada uji sah dan tidak sah |

Harga gas mainnet saat diuji sekitar 0,02 gwei.

## 12. Tes serangan yang wajib lolos

- Memakai catatan yang sama dua kali, dalam satu transaksi maupun dua.
- Bukti palsu, bukti milik transaksi lain, bukti dengan akar yang tidak pernah ada.
- Relayer mengganti alamat penerima, biaya, atau sandi.
- Jumlah yang melewati batas bilangan untuk mencetak ETH.
- Memutar ulang bukti di chain lain atau di kontrak lain.
- Reentrancy saat penarikan.
- Sandi auditor yang tidak cocok dengan isi transaksi.
- Setoran di atas batas; setoran saat dihentikan; penarikan saat setoran dihentikan (harus tetap jalan).
- Pohon penuh.
- Penggantian kunci auditor sebelum jeda habis.

## 13. Tahapan

| Tahap | Isi | Selesai bila |
|---|---|---|
| 1 | Sirkuit dan tes sirkuit; ukur waktu bukti | Semua aturan bagian 6 teruji, termasuk kasus yang harus ditolak |
| 2 | Kontrak dan tes serangan di fork lokal | Semua butir bagian 12 lolos |
| 3 | Pustaka klien dan app web | Setor, transfer, tarik, dan pemulihan saldo dari nol berjalan di fork |
| 4 | Relayer | Transfer dan tarik tanpa gas dari wallet pengguna |
| 5 | Alat auditor | Auditor membaca transfer uji; kunci lain tidak membuka apa pun |
| 6 | Testnet publik (46630) | Dipakai orang lain selain pembuatnya |
| 7 | Audit luar | Temuan diperbaiki |
| 8 | Mainnet dengan batas kecil | Setelah tahap 7 |

## 14. Keputusan pemilik

| Keputusan | Usulan awal |
|---|---|
| Aset | ETH saja; satu kolam |
| Pemegang kunci auditor | Pemilik, disimpan di luar jaringan |
| Sistem bukti | PLONK, ditinjau setelah waktu bukti terukur |
| Batas beta di mainnet | 0,1 ETH per setoran, 5 ETH total |
| Biaya protokol | Nol |
| Token | Tidak ada di v1; bila ada, bukan ticker CELLA |

## 15. Alat

Terpasang di Mac ini: Foundry 1.9 (forge, anvil, cast), Node 26, Rust 1.99. Dipasang pada tahap 1, di dalam folder proyek: circom 2.2.3 (`.tools/`), snarkjs 0.7.6, circomlib 2.0.5, circomlibjs 0.1.7.

## 16. Hasil tahap 1 (23 November 2026)

File: `circuits/transact.circom`, `src/cella.mjs`, `test/transact.test.mjs`, `scripts/bench.mjs`.

Ukuran sirkuit: 40.094 batasan R1CS (21.661 non-linear), 16 masukan publik, 62 masukan pribadi. Dalam bentuk PLONK: 59.699 batasan.

Tes sirkuit: 22 dari 22 lolos (`npm test`). Empat alur sah (setor, transfer, tarik dengan biaya relayer, gabung dua catatan) dan 17 serangan yang ditolak:

- mencetak uang, termasuk lewat putaran batas bilangan dan jumlah di batas 2^96;
- memakai catatan orang lain, mencampur catatan dua pemilik, catatan yang tidak pernah disetor, catatan asli dengan jumlah diperbesar;
- catatan yang sama dua kali, akar palsu, posisi salah, nullifier salah, komitmen keluar salah;
- menarik lebih dari yang dibuktikan;
- mengubah sandi auditor, berbohong kepada auditor, menukar kunci auditor, kunci auditor di luar kurva.

Pada tes transfer, auditor membaca pengirim, kedua penerima, dan kedua jumlah dengan benar; kunci lain tidak membuka apa pun.

Waktu bukti, tiga kali jalan, Node 26 di Apple M3 Pro (bukan browser):

| | Groth16 | PLONK |
|---|---|---|
| Waktu per bukti | 1,6 detik | 23,5 detik |
| Ukuran kunci pembukti | 19 MB | 258 MB |
| Bukti asli lolos verifikasi | Ya | Ya |
| Bukti dengan nilai publik diubah | Ditolak | Ditolak |

Kunci uji dibuat dari upacara lokal satu orang dan hanya untuk mengukur; tidak boleh dipakai di chain.

Batas tes ini: tes memeriksa bahwa masukan yang salah ditolak, bukan bahwa sirkuit bebas dari batasan yang kurang. Pemeriksaan itu butuh alat analisis khusus dan audit luar.

Belum diukur: waktu bukti di browser dan di ponsel.

## 17. Hasil tahap 2 (23 November 2026)

File: `contracts/CellaPool.sol`, `contracts/Groth16Verifier.sol` (dibuat otomatis dari kunci uji), `contracts/test/Helpers.sol`, `test/pool.test.mjs`, `scripts/export-verifier.mjs`.

Kontrak `CellaPool` berukuran 7,2 KB. Hash Poseidon di chain memakai kontrak yang dibangkitkan circomlibjs.

Tes kontrak: 18 dari 18 lolos (`node --test test/pool.test.mjs`), dengan bukti Groth16 asli, di salinan lokal mainnet Robinhood Chain (anvil fork, chain ID 4663). Tidak ada yang dikirim ke chain asli.

Yang diuji:

- Alur sah: setor, transfer lewat relayer dengan biaya, tarik; auditor membaca transfer dari event chain.
- Ditolak: mengirim ulang transaksi yang sama, memakai catatan dua kali, bukti karangan, akar tidak dikenal, nullifier di luar batas bilangan.
- Ditolak: relayer mengubah penerima, jumlah, biaya, penerima biaya, atau sandi catatan.
- Ditolak: nilai ETH tidak cocok, setoran di atas batas, setoran di atas batas kolam.
- Setoran dihentikan: setoran ditolak, transfer dan tarik tetap jalan.
- Ditolak: fungsi pemilik dipanggil orang lain; kepemilikan pindah dalam dua langkah.
- ETH kiriman langsung ditolak; ETH yang dipaksa masuk tidak mengubah pembukuan.
- Ditolak: bukti untuk kolam lain atau chain lain.
- Masuk ulang saat tarik ditolak dan hanya membayar sekali.
- Kunci auditor: titik di luar kurva ditolak, jeda 7 hari dipaksa, kunci lama berhenti berlaku setelah penggantian.
- Riwayat akar: akar sebelumnya diterima, akar yang sudah terlupa ditolak.
- Pohon penuh, nullifier kembar, jumlah di luar batas, tarik tanpa penerima.
- Pembukuan: saldo kolam sama dengan setoran dikurangi tarikan dan biaya.

Gas terukur di fork:

| Tindakan | Gas | Biaya pada 0,02 gwei |
|---|---|---|
| Setor (pertama) | 1.747.407 | sekitar 0,000035 ETH |
| Transfer | 1.317.025 | sekitar 0,000027 ETH |
| Tarik | 1.343.990 | sekitar 0,000027 ETH |

Angka ini gas eksekusi di salinan lokal. Biaya data L1 yang ditambahkan Robinhood Chain belum termasuk dan baru terukur di testnet.

Temuan saat menguji: alamat uji bawaan anvil membawa kode penyapu (delegasi EIP-7702) di Robinhood Chain asli, dan fork menyalinnya, sehingga ETH yang dikirim ke alamat itu langsung disedot. Tes memakai kunci acak baru. Jangan pernah memakai kunci uji bawaan untuk apa pun di chain ini.

Belum dikerjakan di tahap 2: analisis statis (slither), fuzzing, dan skrip deploy.

## 18. Hasil tahap 3 (23 November 2026)

File baru:

| File | Isi |
|---|---|
| `src/cella.mjs` | Ditulis ulang dengan BigInt murni (Poseidon dari poseidon-lite, Baby Jubjub sendiri) supaya jalan di browser |
| `src/keys.mjs` | Kunci Cella diturunkan dari satu tanda tangan wallet |
| `src/notes.mjs` | Sandi catatan untuk penerima: X25519, HKDF-SHA256, AES-256-GCM, 124 byte |
| `src/client.mjs` | Klien: membaca event, menemukan catatan milik sendiri, setor, kirim, tarik, gabung catatan |
| `contracts/CellaRegistry.sol` | Buku alamat: alamat 0x ke kunci Cella; tanpa dana, tanpa pemilik |
| `web/` | App web (Vite, tanpa framework) |
| `scripts/dev-chain.mjs` | Salinan lokal Robinhood Chain dengan Cella ter-deploy, untuk mencoba app |

Tes: 51 dari 51 lolos (`npm test`), dijalankan dua kali berturut-turut.

- `test/math.test.mjs` (1): matematika BigInt cocok dengan circomlibjs.
- `test/transact.test.mjs` (22): sirkuit, tidak berubah.
- `test/pool.test.mjs` (18): kontrak, tidak berubah.
- `test/client.test.mjs` (10): kunci selalu sama untuk wallet yang sama; hanya penerima yang bisa membuka catatan; daftar alamat; setor lalu kirim lewat alamat 0x; **pemulihan dari nol** (klien baru yang hanya punya wallet menemukan saldonya); tarik; pembayaran yang butuh lebih dari dua catatan digabung dulu; penolakan sebelum transaksi; orang luar tidak melihat saldo apa pun; saldo kolam sama dengan jumlah saldo pengguna.

Diuji di browser (dompet uji lokal, fork lokal):

- Membuka saldo privat: tanda tangan, pendaftaran alamat, baca catatan.
- Setor 0,08 ETH, kirim 0,03 ETH ke dompet kedua, tarik 0,02 ETH: semuanya berhasil.
- Dompet kedua, setelah halaman dimuat ulang dan dibuka lagi, melihat 0,03 ETH.
- Pesan galat untuk setoran di atas batas, penerima belum terdaftar, dan saldo kurang.
- Waktu bukti di browser desktop: sekitar 2 sampai 2,4 detik. Ponsel belum diukur.

Kesalahan yang ditemukan dan diperbaiki: klien memakai nomor blok dari cache sehingga saldo bisa tertinggal sesaat setelah transaksi sendiri; cache dimatikan untuk sinkronisasi.

Belum ada di tahap 3:

- Wallet sungguhan (MetaMask, Trust Wallet, Robinhood Wallet) belum diuji; hanya dompet uji lokal.
- Tanpa relayer, alamat pembayar gas terlihat pada setiap transfer (tahap 4).
- Riwayat hanya berupa daftar catatan, belum riwayat "kirim ke siapa".
- Sinkronisasi membaca semua event dari awal; untuk kolam yang ramai perlu pengindeks.
- Kunci pembukti 19 MB diunduh penuh setiap kali; belum ada cache.
