import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ReactionKind } from '../director/templates.js';
import { REACTION_KINDS } from '../director/templates.js';

export interface Persona {
  id: string;
  name: string;
  aliases: string[];
  color: string;
  bio: string;
  style: string;
  traits: string[];
  slang: string[];
  /** key = id bot lain */
  relationships: Record<string, string>;
  typingSpeed: number;
  reactions: Partial<Record<ReactionKind, string[]>>;
  closers: string[];
}

function fail(file: string, msg: string): never {
  throw new Error(`Persona "${file}": ${msg}`);
}

function strField(o: Record<string, unknown>, key: string, file: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v.trim()) fail(file, `field "${key}" wajib berupa string tidak kosong`);
  return v.trim();
}

function strArray(o: Record<string, unknown>, key: string, file: string, required = false): string[] {
  const v = o[key];
  if (v === undefined) {
    if (required) fail(file, `field "${key}" wajib ada`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(file, `field "${key}" harus array string`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

export function parsePersona(raw: unknown, file = '(inline)'): Persona {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(file, 'harus berupa objek JSON');
  const o = raw as Record<string, unknown>;
  const id = strField(o, 'id', file).toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(id)) fail(file, `id "${id}" hanya boleh huruf kecil, angka, - dan _`);

  const relationships: Record<string, string> = {};
  if (o.relationships !== undefined) {
    if (typeof o.relationships !== 'object' || o.relationships === null || Array.isArray(o.relationships)) {
      fail(file, 'field "relationships" harus objek {idBot: deskripsi}');
    }
    for (const [k, v] of Object.entries(o.relationships)) {
      if (typeof v !== 'string') fail(file, `relationships.${k} harus string`);
      relationships[k.toLowerCase()] = v;
    }
  }

  const reactions: Persona['reactions'] = {};
  if (o.reactions !== undefined) {
    if (typeof o.reactions !== 'object' || o.reactions === null || Array.isArray(o.reactions)) {
      fail(file, 'field "reactions" harus objek');
    }
    for (const [k, v] of Object.entries(o.reactions)) {
      if (!REACTION_KINDS.includes(k as ReactionKind)) {
        fail(file, `jenis reaksi "${k}" tidak dikenal (pilihan: ${REACTION_KINDS.join(', ')})`);
      }
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(file, `reactions.${k} harus array string`);
      reactions[k as ReactionKind] = v as string[];
    }
  }

  const speed = o.typingSpeed === undefined ? 1 : Number(o.typingSpeed);
  if (!Number.isFinite(speed) || speed <= 0) fail(file, 'typingSpeed harus angka > 0');

  return {
    id,
    name: strField(o, 'name', file),
    aliases: strArray(o, 'aliases', file),
    color: typeof o.color === 'string' ? o.color : '#888888',
    bio: strField(o, 'bio', file),
    style: strField(o, 'style', file),
    traits: strArray(o, 'traits', file, true),
    slang: strArray(o, 'slang', file),
    relationships,
    typingSpeed: speed,
    reactions,
    closers: strArray(o, 'closers', file),
  };
}

/** Pastikan roster konsisten: id/nama unik, minimal 2 bot. */
export function validateRoster(personas: Persona[]): string[] {
  if (personas.length < 2) throw new Error('Butuh minimal 2 persona agar ada obrolan antar-bot.');
  const warnings: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const p of personas) {
    if (ids.has(p.id)) throw new Error(`Persona id duplikat: ${p.id}`);
    if (names.has(p.name.toLowerCase())) throw new Error(`Persona nama duplikat: ${p.name}`);
    ids.add(p.id);
    names.add(p.name.toLowerCase());
  }
  for (const p of personas) {
    for (const rel of Object.keys(p.relationships)) {
      if (!ids.has(rel)) warnings.push(`${p.id}: relationship ke "${rel}" tidak ada di roster`);
    }
  }
  if (personas.length > 4) warnings.push(`Roster berisi ${personas.length} bot; disarankan 3-4 agar obrolan tidak ramai.`);
  if (personas.length < 3) warnings.push(`Roster hanya ${personas.length} bot; disarankan 3-4.`);
  return warnings;
}

export function loadPersonas(dir: string, only?: string[] | null): Persona[] {
  const files = readdirSync(dir)
    .filter((f) => ['.json'].includes(extname(f)))
    .sort();
  const all = files.map((f) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`Persona "${f}": JSON tidak valid (${(e as Error).message})`);
    }
    return parsePersona(raw, f);
  });
  if (!only?.length) return all;
  const wanted = only.map((s) => s.toLowerCase());
  const picked = wanted.map((id) => {
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`BOT_IDS menyebut "${id}" tapi file persona-nya tidak ada di ${dir}`);
    return p;
  });
  return picked;
}
