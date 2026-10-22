import { describe, expect, it } from 'vitest';
import { loadPersonas, parsePersona, validateRoster } from './persona.js';

const base = { id: 'x', name: 'X', bio: 'b', style: 's', traits: ['t'] };

describe('persona', () => {
  it('memuat persona bawaan dan roster valid', () => {
    const ps = loadPersonas('./personas');
    expect(ps.map((p) => p.id)).toEqual(['bayu', 'kevin', 'rina', 'sari']);
    expect(validateRoster(ps)).toEqual([]);
  });

  it('BOT_IDS memilih dan mengurutkan', () => {
    expect(loadPersonas('./personas', ['sari', 'rina']).map((p) => p.id)).toEqual(['sari', 'rina']);
    expect(() => loadPersonas('./personas', ['nobody'])).toThrow(/nobody/);
  });

  it('memberi pesan error yang jelas untuk field yang kurang/salah', () => {
    expect(() => parsePersona({ ...base, name: '' }, 'a.json')).toThrow(/a\.json.*name/);
    expect(() => parsePersona({ ...base, id: 'Bad Id' })).toThrow(/id/);
    expect(() => parsePersona({ ...base, traits: undefined })).toThrow(/traits/);
    expect(() => parsePersona({ ...base, reactions: { nope: ['x'] } })).toThrow(/nope/);
    expect(() => parsePersona({ ...base, typingSpeed: 0 })).toThrow(/typingSpeed/);
  });

  it('roster: duplikat ditolak, relasi ke bot tak ada diberi warning', () => {
    const a = parsePersona({ ...base, id: 'a', name: 'A', relationships: { ghost: 'hmm' } });
    const b = parsePersona({ ...base, id: 'b', name: 'B' });
    expect(validateRoster([a, b]).some((w) => w.includes('ghost'))).toBe(true);
    expect(() => validateRoster([a, a])).toThrow(/duplikat/);
    expect(() => validateRoster([a])).toThrow(/minimal 2/);
  });
});
