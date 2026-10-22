import type { Persona } from '../persona/persona.js';

export type ReactionKind = 'laugh' | 'agree' | 'surprise' | 'emoji' | 'ack' | 'think';

export const REACTION_KINDS: ReactionKind[] = ['laugh', 'agree', 'surprise', 'emoji', 'ack', 'think'];

const DEFAULTS: Record<ReactionKind, string[]> = {
  laugh: ['wkwk', 'wkwkwk', 'hahaha', 'ngakak', 'wkwk iya', 'kocak sih'],
  agree: ['iya sih', 'bener juga', 'nah itu', 'setuju', 'hmm iya ya', 'bener tuh'],
  surprise: ['lah', 'serius?', 'hah?', 'waduh', 'masa sih', 'wah'],
  emoji: ['😂', '😅', '🤣', '👍', '🔥', '😭'],
  ack: ['iya?', 'apa tuh?', 'hmm?', 'kenapa nih', 'yo', 'kenapa kenapa'],
  think: ['hmm bentar ya', 'wah gatau juga sih', 'bentar mikir dulu', 'gimana ya', 'hmm susah juga'],
};

const rand = <T>(arr: T[], rng: () => number): T =>
  arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))] as T;

/** Reaksi ringan tanpa LLM. Template persona dicampur dengan template umum. */
export function pickReaction(kind: ReactionKind, persona: Persona | undefined, rng: () => number): string {
  const own = persona?.reactions[kind] ?? [];
  // Template persona diprioritaskan (60%) agar suara tiap bot tetap beda.
  if (own.length && rng() < 0.6) return rand(own, rng);
  return rand(DEFAULTS[kind], rng);
}

export function pickCloser(persona: Persona, rng: () => number, userName: string): string {
  const pool = persona.closers.length ? persona.closers : ['yaudah lanjut besok ya'];
  return rand(pool, rng).replaceAll('{user}', userName);
}
