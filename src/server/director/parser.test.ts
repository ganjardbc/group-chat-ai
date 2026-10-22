import { describe, expect, it } from 'vitest';
import { parseScript } from './parser.js';

const roster = [
  { id: 'rina', name: 'Rina', aliases: ['rin'] },
  { id: 'bayu', name: 'Bayu' },
  { id: 'sari', name: 'Sari', aliases: ['mbak sari'] },
];

describe('parseScript', () => {
  it('format bersih', () => {
    const p = parseScript(
      'Rina: wkwk lu mah\nBayu: apaan sih\nLANJUT: ya\nALASAN: ledekan belum selesai',
      roster,
    );
    expect(p.ok).toBe(true);
    expect(p.lines.map((l) => [l.speakerId, l.text])).toEqual([
      ['rina', 'wkwk lu mah'],
      ['bayu', 'apaan sih'],
    ]);
    expect(p.cont).toBe(true);
    expect(p.reason).toBe('ledekan belum selesai');
    expect(p.warnings).toEqual([]);
  });

  it('toleran markdown, bullet, nomor, kurung siku, kode fence', () => {
    const p = parseScript(
      '```\n**Rina**: halo\n- Bayu : hai\n2. [Sari]: yo wis\n**Kevin:** gk ada\n```\n**LANJUT:** tidak\n**ALASAN:** selesai',
      [...roster, { id: 'kevin', name: 'Kevin' }],
    );
    expect(p.lines.map((l) => l.speakerId)).toEqual(['rina', 'bayu', 'sari', 'kevin']);
    expect(p.lines[3]?.text).toBe('gk ada');
    expect(p.cont).toBe(false);
  });

  it('alias, kapital bebas, dan keterangan dalam kurung', () => {
    const p = parseScript('rin: eh\nMBAK SARI: iya lho\nBayu (datar): hmm', roster);
    expect(p.lines.map((l) => l.speakerId)).toEqual(['rina', 'sari', 'bayu']);
    expect(p.lines[2]?.text).toBe('hmm');
  });

  it('membuang pembicara tak dikenal tapi menyimpan sisanya', () => {
    const p = parseScript('Catatan: ini skrip\nRina: oke\nBudi: aku nyela\nBayu: lanjut', roster);
    expect(p.lines.map((l) => l.speakerId)).toEqual(['rina', 'bayu']);
    expect(p.warnings.some((w) => w.includes('Budi'))).toBe(true);
  });

  it('baris tanpa label menjadi pesan lanjutan pembicara sebelumnya; pembuka dibuang', () => {
    const p = parseScript('Berikut skripnya\nRina: eh tau gak\ntadi gue liat kucing\nLANJUT: ya', roster);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[1]).toMatchObject({ speakerId: 'rina', text: 'tadi gue liat kucing' });
    expect(p.warnings.some((w) => w.includes('Berikut'))).toBe(true);
  });

  it('titik dua di dalam kalimat tanpa label tidak dianggap pembicara', () => {
    const p = parseScript('Rina: jadwal kita\njam 5 sore nanti: ketemu di cafe', roster);
    expect(p.lines[1]).toMatchObject({ speakerId: 'rina', text: 'jam 5 sore nanti: ketemu di cafe' });
  });

  it('footer hilang -> cont null dengan warning, tetap ok', () => {
    const p = parseScript('Rina: halo\nBayu: hai', roster);
    expect(p.ok).toBe(true);
    expect(p.cont).toBeNull();
    expect(p.warnings).toContain('footer LANJUT tidak ada');
  });

  it('variasi nilai LANJUT dan alasan multibaris', () => {
    expect(parseScript('Rina: a\nLANJUT: Iya', roster).cont).toBe(true);
    expect(parseScript('Rina: a\nLANJUT: nggak', roster).cont).toBe(false);
    expect(parseScript('Rina: a\nLANJUT: mungkin', roster).cont).toBeNull();
    const p = parseScript('Rina: a\nLANJUT: ya\nALASAN: karena\nmasih seru', roster);
    expect(p.reason).toBe('karena masih seru');
  });

  it('membuang tag <think> (termasuk yang tak tertutup) dan kutip pembungkus', () => {
    const p = parseScript('<think>Rina: palsu</think>\nRina: "halo semua"\n<think>belum selesai', roster);
    expect(p.lines).toEqual([{ speakerId: 'rina', speakerName: 'Rina', text: 'halo semua' }]);
  });

  it('format Windows (CRLF) dan fullwidth colon', () => {
    const p = parseScript('Rina：hai\r\nBayu: yo\r\nLANJUT: ya\r\n', roster);
    expect(p.lines).toHaveLength(2);
  });

  it('input rusak total -> ok false', () => {
    expect(parseScript('', roster).ok).toBe(false);
    expect(parseScript('maaf, saya tidak bisa membantu', roster).ok).toBe(false);
    expect(parseScript('LANJUT: ya', roster).ok).toBe(false);
  });

  it('memotong pesan terlalu panjang', () => {
    const p = parseScript('Rina: ' + 'a'.repeat(1000), roster);
    expect(p.lines[0]?.text.length).toBe(300);
  });
});
