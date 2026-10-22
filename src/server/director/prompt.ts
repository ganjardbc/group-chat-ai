import type { ChatMessage } from '../../shared/protocol.js';
import type { LlmMessage } from '../llm-client/client.js';
import type { Persona } from '../persona/persona.js';
import type { RoundMode } from './gate.js';

export interface PromptInput {
  bots: Persona[];
  mode: RoundMode;
  /** id bot yang namanya disebut pengguna */
  forced: string[];
  maxLines: number;
  summary: string;
  facts: string[];
  recent: ChatMessage[];
  /** nama pengguna manusia yang aktif */
  humans: string[];
}

const RULES = `Kamu adalah SUTRADARA obrolan grup chat santai berbahasa Indonesia (gaya WhatsApp). Tugasmu menulis potongan skrip percakapan natural antar anggota grup. Kamu BUKAN asisten AI dan anggota grup juga bukan asisten.

ATURAN:
- Tiap baris: "Nama: pesan". Hanya pakai nama dari daftar ANGGOTA. Jangan menulis pesan atas nama pengguna manusia.
- Tulis 1 sampai {MAX} baris saja. Tidak semua anggota harus bicara; diam itu wajar.
- Pesan PENDEK (biasanya 2-12 kata), terpecah-pecah seperti orang ngetik di HP. Boleh huruf kecil semua, singkatan, slang (wkwk, gak, bgt, sih, dong, anjir). DILARANG paragraf rapi, daftar, atau penjelasan panjang ala asisten AI.
- Pertahankan karakter tiap anggota dan hubungan antar mereka (meledek, membela, dst). Jangan mengulang kalimat yang sudah ada di obrolan.
- Jangan pernah menyebut diri AI, bot, model, atau skrip.
- Tutup dengan tepat dua baris:
LANJUT: ya  atau  LANJUT: tidak   (ya = anggota masih wajar saling nyambung sendiri tanpa menunggu manusia; tidak = tunggu manusia)
ALASAN: satu kalimat singkat`;

// Placeholder {A}..{D} diisi nama dari roster agar contoh selalu cocok dengan anggota grup.
const FEW_SHOT: string[] = [
  `Obrolan:
Budi: ada rekomendasi makan malam gak? bingung nih
Keluaran:
{A}: nasi goreng depan kantor aja bud
{B}: yaelah itu mulu, bosen
{A}: ya terus lu mau apa
LANJUT: ya
ALASAN: A dan B masih adu pendapat soal makanan`,
  `Obrolan:
Budi: @{C} menurut lo film kemarin gimana?
Keluaran:
{C}: hmm bagus sih, tapi endingnya gantung
{D}: setuju, plot twist-nya kebanyakan wkwk
LANJUT: tidak
ALASAN: pertanyaan Budi sudah dijawab, tunggu Budi`,
  `Obrolan:
Budi: tadi macet parah banget
Keluaran:
{B}: lah lu berangkat jam berapa emang
{A}: pasti jam 9 wkwk kebiasaan
{B}: sembarangan, jam 8 kurang 5 menit ya
{A}: sama aja anjir
LANJUT: ya
ALASAN: ledekan A ke B belum selesai`,
  `Obrolan:
(grup sepi beberapa menit, tugas: pancing topik baru)
Keluaran:
{D}: eh kalian udah nonton trailer game baru itu belum
{C}: belum, emang udah rilis?
LANJUT: ya
ALASAN: topik baru baru dilempar, yang lain pasti nyambung`,
];

function fillNames(template: string, bots: Persona[]): string {
  const name = (i: number) => bots[i % bots.length]!.name;
  return template.replaceAll('{A}', name(0)).replaceAll('{B}', name(1)).replaceAll('{C}', name(2)).replaceAll('{D}', name(3));
}

function describeBot(p: Persona, all: Persona[]): string {
  const rels = Object.entries(p.relationships)
    .map(([id, d]) => {
      const other = all.find((b) => b.id === id);
      return other ? `${other.name}: ${d}` : null;
    })
    .filter(Boolean)
    .join(' | ');
  return [
    `- ${p.name} — ${p.bio}`,
    `  Gaya bicara: ${p.style}`,
    `  Sifat: ${p.traits.join(', ')}.${p.slang.length ? ` Slang khas: ${p.slang.join(', ')}.` : ''}`,
    rels ? `  Hubungan: ${rels}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function modeInstruction(input: PromptInput): string {
  const forced = input.forced
    .map((id) => input.bots.find((b) => b.id === id)?.name)
    .filter(Boolean) as string[];
  const lastUser = input.humans[input.humans.length - 1] ?? 'pengguna';
  switch (input.mode) {
    case 'reply':
      return (
        `${lastUser} baru saja mengirim pesan terakhir di atas. Tentukan siapa yang menanggapi (1-3 anggota, urutan natural).` +
        (forced.length ? ` Yang namanya disebut WAJIB menjawab: ${forced.join(', ')}.` : '') +
        ' Boleh ada yang diam atau cuma bereaksi singkat.'
      );
    case 'continue':
      return 'Anggota boleh nyambung obrolan sendiri satu-dua kalimat lagi (jangan mengulang), atau berhenti kalau obrolan sudah selesai. Jangan menyapa pengguna kecuali wajar.';
    case 'topic':
      return 'Grup sedang sepi. Satu anggota memancing topik baru yang ringan dan cocok dengan minat/fakta grup (jangan formal, jangan menyebut grup sepi), anggota lain boleh menyambung.';
  }
}

export function buildScriptMessages(input: PromptInput): LlmMessage[] {
  const system = [
    RULES.replace('{MAX}', String(input.maxLines)),
    '',
    'ANGGOTA:',
    ...input.bots.map((b) => describeBot(b, input.bots)),
    '',
    'CONTOH FORMAT (nama pada contoh sudah disesuaikan; jangan menyalin isinya):',
    ...FEW_SHOT.map((s, i) => `[Contoh ${i + 1}]\n${fillNames(s, input.bots)}`),
  ].join('\n');

  const parts: string[] = [];
  if (input.summary) parts.push(`RINGKASAN OBROLAN SEBELUMNYA:\n${input.summary}`);
  if (input.facts.length) parts.push(`FAKTA GRUP:\n${input.facts.map((f) => `- ${f}`).join('\n')}`);
  const chat = input.recent.length
    ? input.recent.map((m) => `${m.senderName}: ${m.text}`).join('\n')
    : '(belum ada pesan)';
  parts.push(`OBROLAN TERAKHIR:\n${chat}`);
  parts.push(`TUGAS: ${modeInstruction(input)} Maksimal ${input.maxLines} baris. Keluarkan hanya baris "Nama: pesan" lalu LANJUT dan ALASAN.`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export const RETRY_NOTE =
  'Format tadi tidak bisa dibaca. Ulangi HANYA dengan baris "Nama: pesan" (nama dari daftar anggota), lalu "LANJUT: ya/tidak" dan "ALASAN: ...". Tanpa kalimat pembuka, tanpa markdown.';
