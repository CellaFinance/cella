# Cella — panduan deploy ke testnet

Untuk Robinhood Chain Testnet (chain ID 46630). Mainnet sengaja diblokir di skrip sampai upacara kunci terbuka dan audit luar selesai.

Semua perintah dijalankan dari folder `~/Documents/cella`.

> Status 23 November 2026: langkah 1 sampai 4 sudah dijalankan. Alamat kontrak ada di `deployments/46630.json` dan di `docs/RANCANGAN.md` bagian 23. Uji dengan wallet sungguhan (Trust Wallet di Chrome) juga sudah. Situs dan relayer sudah terbit di https://cella-br5.pages.dev (langkah 5 dan 6).

## Yang sudah disiapkan

| Hal | Keadaan |
|---|---|
| Skrip deploy `scripts/deploy.mjs` | Sudah digladi di salinan lokal testnet: 4 kontrak, 6 pemeriksaan lolos, total 5,97 juta gas |
| Kunci deployer | `~/.config/cella/deployer.key`, alamat `0x7B7A875eC79A581cE5e4E391efAcF9D903F288c4` |
| Kunci relayer | `~/.config/cella/relayer.key`, alamat `0x9CE1e7a92093e6aD8D981632bCD9B10E72F18DBF` |
| Build situs `scripts/build-web.mjs` | Sudah diuji sebagai file statis: setor, tarik lewat relayer, halaman auditor |

Kedua file kunci berada di luar repo, hanya bisa dibaca pemilik Mac ini, dan isinya tidak pernah dicetak. Keduanya kunci testnet; jangan dipakai untuk dana nyata.

## Langkah 1 — ETH testnet (dikerjakan pemilik)

Kirim ETH testnet ke dua alamat di atas. Kebutuhan:

- Deployer: deploy memakan sekitar 6 juta gas. Pada harga gas testnet saat diukur (0,01 gwei) itu sekitar 0,00006 ETH, belum termasuk biaya data L1. 0,01 ETH sudah jauh lebih dari cukup.
- Relayer: tiap transaksi yang diteruskan memakan sekitar 1,3 juta gas dan dibayar kembali lewat biaya. 0,01 ETH cukup untuk memulai.

Faucet tercantum di dokumentasi resmi: https://docs.robinhood.com/chain/connecting

## Langkah 2 — kunci auditor (dikerjakan pemilik)

```bash
node auditor/auditor.mjs keygen --out ~/.config/cella/auditor-testnet.json
```

File ini berisi rahasia auditor. Siapa pun yang memegangnya bisa membaca semua transfer di kolam testnet.

## Langkah 3 — gladi

```bash
node scripts/deploy.mjs --network testnet --auditor-file ~/.config/cella/auditor-testnet.json --dry-run
```

Menjalankan seluruh deploy di salinan lokal testnet. Tidak ada yang dikirim ke chain asli.

## Langkah 4 — deploy

```bash
node scripts/deploy.mjs --network testnet --auditor-file ~/.config/cella/auditor-testnet.json
```

Skrip berhenti sendiri bila: RPC menjawab untuk chain lain, alamat deployer punya kode di chain, saldo deployer nol, atau salah satu pemeriksaan sesudah deploy gagal. Hasilnya tersimpan di `deployments/46630.json`.

## Langkah 5 dan 6 — situs dan relayer di Cloudflare Pages

Situs dan relayer diterbitkan bersama. Relayer berjalan sebagai fungsi di alamat situs itu sendiri (`/api/relayer`), jadi tidak ada server lain yang perlu hidup.

Sekali saja, masuk ke Cloudflare (membuka browser):

```bash
NODE_OPTIONS=--dns-result-order=ipv4first npx wrangler login --scopes account:read user:read pages:write
```

Izin itu hanya untuk Pages; domain dan tunnel lain di akun yang sama tidak ikut terbuka.

Lalu terbitkan:

```bash
NODE_OPTIONS=--dns-result-order=ipv4first sh scripts/publish.sh
```

Skrip itu membangun situs untuk `deployments/46630.json`, membuat proyek Pages bernama `cella` bila belum ada, mengirim kunci relayer sebagai rahasia (tidak dicetak), dan mengunggah `build/web` beserta folder `functions/`. Alamat situsnya tercetak di akhir.

Relayer membaca kolam, chain, dan RPC dari `deployment.json` milik situs, jadi satu-satunya pengaturan di Cloudflare adalah rahasia `CELLA_RELAYER_KEY`.

Untuk mencoba di Mac tanpa menerbitkan:

```bash
npx wrangler pages dev build/web --port 8788 --binding "CELLA_RELAYER_KEY=$(cat ~/.config/cella/relayer.key)"
```

Relayer versi server biasa (`relayer/main.mjs`) tetap ada untuk dijalankan di mesin sendiri.

Batas yang diketahui dari versi Pages:

- Paket gratis membatasi waktu CPU per permintaan. Di emulator lokal batas itu tidak berlaku, jadi baru terukur setelah diterbitkan.
- Tidak ada antrean bersama antar salinan fungsi; dua permintaan bersamaan bisa berebut nonce, lalu yang kalah mencoba lagi sampai tiga kali.
- Pembatas permintaan per IP hanya perkiraan; untuk yang sungguhan pakai aturan rate limiting di dasbor Cloudflare.

## Langkah 7 — uji di testnet

1. Buka situs dengan wallet sungguhan, tambah jaringan testnet, buka saldo privat.
2. Setor jumlah kecil, kirim ke wallet kedua, tarik.
3. Baca kolam sebagai auditor:

```bash
node auditor/auditor.mjs read --key ~/.config/cella/auditor-testnet.json --deployment deployments/46630.json
```

Baris terakhir keluarannya harus menyatakan saldo cocok dengan isi kolam.

## Yang belum pernah diuji

- Wallet sungguhan (MetaMask, Trust Wallet, Robinhood Wallet) dan ponsel. Sejauh ini hanya dompet uji lokal.
- Biaya data L1 di chain asli; semua angka gas berasal dari salinan lokal.
- Verifikasi kode kontrak di penjelajah blok; belum ada skripnya.
- Analisis statis kontrak (slither belum terpasang di Mac ini).

## Catatan salinan lokal

`node scripts/dev-chain.mjs` membuat salinan mainnet yang menua: setelah sekitar satu jam RPC publik tidak lagi melayani keadaan lama, dan alamat yang belum pernah disentuh gagal dibaca. Nyalakan ulang salinannya bila itu terjadi.
