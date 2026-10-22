# Group Chat AI

MVP aplikasi group chat: kamu ngobrol bareng 3-4 bot AI yang terasa seperti orang sungguhan.
Bot tidak membalas tiap pesan: sebuah **Director** memutuskan siapa bicara, siapa diam, dan kapan obrolan berhenti.

Stack: TypeScript, Node.js 22+, WebSocket (`ws`), SQLite (`node:sqlite` bawaan Node), React (Vite).
LLM lewat 9router (endpoint kompatibel OpenAI).

## Menjalankan

Butuh Node.js >= 22.13.

```bash
npm install
cp .env.example .env      # lalu isi NINEROUTER_BASE_URL, NINEROUTER_API_KEY, MODEL_MAIN, MODEL_LIGHT

# produksi (satu proses, frontend ikut disajikan)
npm run build
npm start                 # http://localhost:3000

# pengembangan (dua terminal)
npm run dev               # server dengan auto-reload, :3000
npm run dev:web           # Vite, :5173 (proxy WebSocket ke :3000)
```

Tanpa API key? Jalankan fake 9router untuk mencoba:

```bash
npm run dev:fake-llm      # http://localhost:20128/v1, balasan tiruan
# di .env: NINEROUTER_BASE_URL=http://localhost:20128/v1, MODEL_MAIN=apa-saja, MODEL_LIGHT=apa-saja
```

Kalau `.env` belum diisi, server tetap jalan dan bot hanya memakai reaksi template (mode degradasi).

Tes dan pengecekan tipe:

```bash
npm test
npm run typecheck
```

## `.env.example`

```dotenv
# ── LLM via 9router (endpoint kompatibel OpenAI) ─────────────────────────────
# Base URL sampai /v1 (client menambahkan /chat/completions)
NINEROUTER_BASE_URL=http://localhost:20128/v1
NINEROUTER_API_KEY=isi-api-key-di-sini
# Model utama: dialog skrip. Boleh beberapa dipisah koma = urutan fallback saat limit/error.
MODEL_MAIN=cc/claude-sonnet-4-5
# Model ringan: ringkasan & fakta; juga cadangan terakhir untuk dialog.
MODEL_LIGHT=cc/claude-haiku-4-5
# Batas token keluaran (rendah = hemat)
MAX_TOKENS_MAIN=280
MAX_TOKENS_LIGHT=160
LLM_TIMEOUT_MS=20000

# ── Server ───────────────────────────────────────────────────────────────────
PORT=3000
GROUP_NAME=Geng Receh
DB_PATH=./data/chat.db
PERSONAS_DIR=./personas
# Opsional: pilih & urutkan persona (default: semua file di PERSONAS_DIR, disarankan 3-4)
# BOT_IDS=rina,bayu,sari,kevin
LLM_LOG_FILE=./data/llm.log.jsonl
# LOG_LEVEL=debug

# ── Director: batas keras ────────────────────────────────────────────────────
# Maks giliran bot-ke-bot berturut-turut tanpa pesan pengguna (3-4 disarankan)
MAX_BOT_STREAK=4
# Maks baris dialog per babak (per panggilan LLM)
MAX_LINES_PER_ROUND=4
# Maks pesan bot per menit per grup
RATE_LIMIT_PER_MIN=10
# Pengguna idle sekian menit -> bot pamit lalu diam total
IDLE_STOP_MIN=5
# Grup sepi sekian detik -> boleh memancing topik baru
TOPIC_IDLE_SEC=75
# Jarak minimum antar pancingan topik (menit) dan maksimum per periode sepi
TOPIC_MIN_INTERVAL_MIN=3
MAX_TOPICS_PER_IDLE=2
# Peluang bot bereaksi template (tanpa LLM) pada pesan ringan seperti "wkwk"
REACT_PROBABILITY=0.5
# Interval cek idle (detik)
TICK_SEC=5

# ── Konteks & memori ─────────────────────────────────────────────────────────
CONTEXT_MESSAGES=18
# Rangkum ulang setiap sekian pesan lama yang keluar dari jendela konteks
SUMMARY_BATCH=8

# ── Kesan natural ────────────────────────────────────────────────────────────
# Pengali kecepatan mengetik bot (1 normal, 2 dua kali lebih cepat, 0 = tanpa jeda)
TYPING_SPEED=1
```

`MODEL_MAIN` / `MODEL_LIGHT` boleh berisi beberapa model dipisah koma. Itu menjadi urutan fallback:
dialog mencoba model utama, lalu model ringan; ringkasan hanya memakai model ringan.
Model yang kena 429/5xx/timeout otomatis di-cooldown (menghormati `Retry-After`) sehingga tidak dipanggil terus-menerus.

## Cara kerja Director

```
pesan pengguna ─► GATE (kode, tanpa LLM) ─► skip | react (template) | close (template) | run
                                                                                   │
                                      1 panggilan LLM per babak: skrip "Nama: pesan" + LANJUT + ALASAN
                                                                                   │
                       parser toleran ─► batas keras (jumlah baris, dedupe, mention) ─► antrean ketik ─► WebSocket
                                                                                   │
                                           LANJUT: ya? ─► gate lagi (streak, rate limit) ─► babak berikutnya
```

**Gate** (`src/server/director/gate.ts`, fungsi murni, mudah dites):

| Aturan | Perilaku |
| --- | --- |
| Mention nama/alias bot | Bot yang disebut *wajib* menjawab (jika LLM lupa, bot membalas dengan template). |
| Pesan ringan ("wkwk", "oke", sangat pendek) | Peluang `REACT_PROBABILITY` dibalas reaksi template **tanpa LLM**, selain itu diabaikan. |
| `MAX_BOT_STREAK` | Maks giliran bot-ke-bot berturut-turut tanpa pesan pengguna. Lewat batas, bot diam menunggu manusia. |
| `RATE_LIMIT_PER_MIN` | Maks pesan bot per menit per grup (jendela bergulir). Juga memangkas jumlah baris tiap babak. |
| Pamitan pengguna ("bye", "tidur dulu") | 1-2 bot menutup dengan template persona (`closers`), lalu diam. |
| Pengguna idle > `IDLE_STOP_MIN` | 1-2 bot pamit, lalu diam total sampai pengguna bicara lagi. |
| Grup sepi > `TOPIC_IDLE_SEC` | Director boleh memancing topik baru; dibatasi `TOPIC_MIN_INTERVAL_MIN` dan `MAX_TOPICS_PER_IDLE`. |

LLM hanya merekomendasikan (`LANJUT`/`ALASAN`); semua batas keras ada di kode.

**Parser** (`parser.ts`) menerima markdown (`**Rina**:`), bullet/nomor, `[Rina]`, kode fence, tag `<think>`,
alias, keterangan dalam kurung, baris lanjutan tanpa label, dan footer yang hilang. Nama tak dikenal dibuang.
Jika tidak ada satu pun baris valid, Director meminta ulang **satu kali**; jika masih gagal, bot memakai template atau diam.

**Kesan natural**
- Pesan masuk antrean (`queue.ts`) dengan jeda ketik acak sebanding panjang pesan dan kecepatan ketik persona, plus event "sedang mengetik".
- Pesan panjang dipecah jadi beberapa bubble pendek.
- Pengguna menyela: pesan bot yang belum terkirim dibatalkan, dan skrip LLM yang sudah basi dibuang.
- Prompt memuat 4 contoh few-shot, nama contohnya otomatis disesuaikan dengan roster.

**Hemat request & ketahanan**
- Konteks: 18 pesan terakhir + rolling summary + maks 6 fakta grup. Pesan lama yang keluar dari jendela dirangkum oleh model ringan tiap `SUMMARY_BATCH` pesan (sekaligus mengekstrak fakta).
- `max_tokens` rendah (`MAX_TOKENS_MAIN`, `MAX_TOKENS_LIGHT`).
- Semua model gagal → bot membalas dengan template atau diam; pengguna tidak pernah melihat pesan error.
- Setiap panggilan LLM ditulis ke `LLM_LOG_FILE` (JSONL): `event: "call"` (model, latensi, status, token, cooldown) dan `event: "parse"` (ok, jumlah baris, `LANJUT`, `ALASAN`, warning, apakah retry).

## Struktur

```
src/shared/protocol.ts        tipe pesan WebSocket (dipakai server & frontend)
src/server/gateway/           HTTP + WebSocket, sanitasi nama, anti-flood
src/server/director/          gate.ts, parser.ts, prompt.ts, templates.ts, director.ts
src/server/persona/           pemuat & validator persona
src/server/llm-client/        klien OpenAI-compatible: fallback model, cooldown, log
src/server/memory/            store.ts (SQLite), memory.ts (rolling summary + fakta)
src/server/queue/             antrean kirim: jeda ketik, indikator mengetik, pembatalan
personas/*.json               definisi persona
web/                          frontend React
scripts/fake-router.ts        9router tiruan untuk demo
```

## Menambah persona baru

1. Buat `personas/namabaru.json`:

```json
{
  "id": "dewi",
  "name": "Dewi",
  "aliases": ["wi", "mbak dewi"],
  "color": "#9c27b0",
  "bio": "Cewek 27 tahun, barista, pecinta kucing.",
  "style": "Santai, banyak emoji kucing, sering kasih fakta random.",
  "traits": ["ramah", "random", "pecinta kucing"],
  "slang": ["meong", "btw", "kayaknya"],
  "relationships": {
    "rina": "Sering diajak gosip Rina tapi pura-pura gak tahu.",
    "bayu": "Suka membelikan Bayu kopi gratis."
  },
  "typingSpeed": 1.0,
  "reactions": { "laugh": ["wkwk 🐱"], "emoji": ["🐱", "☕"] },
  "closers": ["aku tutup kedai dulu ya {user}, sampai besok ☕"]
}
```

2. Restart server. Semua file di `personas/` otomatis ikut. Atau pilih/urutkan lewat `BOT_IDS=rina,bayu,dewi` di `.env`.
   Disarankan 3-4 bot (lebih dari itu diberi peringatan).

Field wajib: `id`, `name`, `bio`, `style`, `traits`. `relationships` berkunci `id` bot lain; makin spesifik, makin hidup interaksinya.
`reactions` (jenis: `laugh`, `agree`, `surprise`, `emoji`, `ack`, `think`) dan `closers` (`{user}` = nama pengguna) dipakai tanpa LLM.
Kesalahan format persona dilaporkan dengan nama file dan field saat server start.

## Catatan MVP

- Satu grup (`main`); skema DB sudah memuat `group_id`.
- `node:sqlite` masih berstatus experimental di Node 22 (muncul `ExperimentalWarning`, tidak berbahaya).
- Nama pengguna tidak diautentikasi.
