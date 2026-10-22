export interface RosterEntry {
  id: string;
  name: string;
  aliases?: string[];
}

export interface ScriptLine {
  speakerId: string;
  speakerName: string;
  text: string;
}

export interface ParsedScript {
  lines: ScriptLine[];
  /** true/false dari "LANJUT:", null kalau tidak ada atau tidak terbaca. */
  cont: boolean | null;
  reason: string | null;
  warnings: string[];
  /** ok = ada minimal satu baris dialog valid. */
  ok: boolean;
}

const MAX_TEXT = 300;
const YES = /^(ya|iya|yes|y|true|lanjut|yep|yoi|ok|oke)\b/i;
const NO = /^(tidak|nggak|enggak|ga|gak|no|n|false|stop|berhenti|tdk)\b/i;

function normLabel(label: string): string {
  return label
    .replace(/\([^)]*\)/g, '') // "Rina (ketawa)" -> "Rina"
    .replace(/[[\]*_@]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function cleanText(text: string): string {
  let t = text.trim();
  // buang pembungkus kutip
  t = t.replace(/^["“”'`]+/, '').replace(/["“”'`]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT).trim();
  return t;
}

/**
 * Parser toleran untuk format:
 *   Nama: pesan
 *   LANJUT: ya/tidak
 *   ALASAN: ...
 * Menerima markdown (**Nama**:), bullet, nomor, [Nama], kode fence, tag <think>,
 * nama tak dikenal (dibuang), baris tanpa label (dianggap lanjutan pembicara sebelumnya),
 * dan footer yang hilang.
 */
export function parseScript(raw: string, roster: RosterEntry[]): ParsedScript {
  const warnings: string[] = [];
  const byName = new Map<string, RosterEntry>();
  for (const r of roster) {
    byName.set(r.name.toLowerCase(), r);
    for (const a of r.aliases ?? []) byName.set(a.toLowerCase(), r);
  }

  const cleaned = (raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '') // think tidak tertutup
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/\r/g, '')
    .replace(/\*\*|__/g, '');

  const lines: ScriptLine[] = [];
  let cont: boolean | null = null;
  let reason: string | null = null;
  let inReason = false;
  let last: RosterEntry | null = null;

  for (const rawLine of cleaned.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^(?:[-*•>]+|\d+[.)])\s*/, '').trim();
    if (!line) continue;

    const m = /^([^:：]{1,40}?)\s*[:：]\s*(.*)$/.exec(line);
    if (m) {
      const label = normLabel(m[1] ?? '');
      const value = (m[2] ?? '').trim();

      if (label === 'lanjut') {
        inReason = false;
        if (YES.test(value)) cont = true;
        else if (NO.test(value)) cont = false;
        else warnings.push(`LANJUT tidak terbaca: "${value}"`);
        continue;
      }
      if (label === 'alasan') {
        inReason = true;
        reason = value;
        continue;
      }
      const entry = byName.get(label);
      if (entry) {
        inReason = false;
        last = entry;
        const text = cleanText(value);
        if (text) lines.push({ speakerId: entry.id, speakerName: entry.name, text });
        else warnings.push(`pesan kosong dari ${entry.name}`);
        continue;
      }
      // Label seperti nama (1-2 kata huruf) tapi tidak dikenal -> buang, bukan lanjutan.
      if (/^[a-z]+(?: [a-z]+)?$/i.test(label)) {
        warnings.push(`pembicara tidak dikenal: "${m[1]?.trim()}"`);
        inReason = false;
        last = null;
        continue;
      }
      // selain itu: titik dua biasa di dalam kalimat -> jatuh ke logika tanpa label.
    }

    if (inReason) {
      reason = `${reason ?? ''} ${line}`.trim();
    } else if (last) {
      const text = cleanText(line);
      if (text) lines.push({ speakerId: last.id, speakerName: last.name, text });
    } else {
      warnings.push(`baris tanpa pembicara dibuang: "${line.slice(0, 40)}"`);
    }
  }

  if (cont === null && !warnings.some((w) => w.startsWith('LANJUT'))) warnings.push('footer LANJUT tidak ada');

  return { lines, cont, reason, warnings, ok: lines.length > 0 };
}
