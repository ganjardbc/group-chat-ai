import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { ChatMessage } from '../../shared/protocol.js';

// createRequire: Vite/Vitest salah menghapus prefix "node:" pada modul sqlite bila di-import statis.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface SummaryRow {
  text: string;
  uptoId: number;
}

type Row = Record<string, unknown>;

export class Store {
  private db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, id);
      CREATE TABLE IF NOT EXISTS summaries (
        group_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        upto_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (group_id, text)
      );
    `);
  }

  close() {
    this.db.close();
  }

  private toMessage(r: Row): ChatMessage {
    return {
      id: Number(r.id),
      groupId: String(r.group_id),
      senderId: String(r.sender_id),
      senderName: String(r.sender_name),
      kind: r.kind === 'bot' ? 'bot' : 'user',
      text: String(r.text),
      ts: Number(r.ts),
    };
  }

  addMessage(m: Omit<ChatMessage, 'id'>): ChatMessage {
    const res = this.db
      .prepare('INSERT INTO messages (group_id, sender_id, sender_name, kind, text, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.groupId, m.senderId, m.senderName, m.kind, m.text, m.ts);
    return { ...m, id: Number(res.lastInsertRowid) };
  }

  /** N pesan terakhir, urut lama -> baru. */
  recent(groupId: string, n: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT ?')
      .all(groupId, n) as Row[];
    return rows.reverse().map((r) => this.toMessage(r));
  }

  /** Pesan dengan afterId < id <= uptoId, urut lama -> baru. */
  range(groupId: string, afterId: number, uptoId: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE group_id = ? AND id > ? AND id <= ? ORDER BY id')
      .all(groupId, afterId, uptoId) as Row[];
    return rows.map((r) => this.toMessage(r));
  }

  latestId(groupId: string): number {
    const r = this.db.prepare('SELECT MAX(id) AS m FROM messages WHERE group_id = ?').get(groupId) as Row | undefined;
    return Number(r?.m ?? 0);
  }

  getSummary(groupId: string): SummaryRow {
    const r = this.db.prepare('SELECT text, upto_id FROM summaries WHERE group_id = ?').get(groupId) as Row | undefined;
    return r ? { text: String(r.text), uptoId: Number(r.upto_id) } : { text: '', uptoId: 0 };
  }

  setSummary(groupId: string, text: string, uptoId: number, now: number) {
    this.db
      .prepare(
        `INSERT INTO summaries (group_id, text, upto_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET text = excluded.text, upto_id = excluded.upto_id, updated_at = excluded.updated_at`,
      )
      .run(groupId, text, uptoId, now);
  }

  /** Fakta terbaru dulu. */
  listFacts(groupId: string, limit: number): string[] {
    const rows = this.db
      .prepare('SELECT text FROM facts WHERE group_id = ? ORDER BY id DESC LIMIT ?')
      .all(groupId, limit) as Row[];
    return rows.map((r) => String(r.text));
  }

  /** Tambah fakta (duplikat diabaikan), simpan maksimal `cap` fakta terbaru. */
  addFacts(groupId: string, texts: string[], now: number, cap = 30) {
    const ins = this.db.prepare('INSERT OR IGNORE INTO facts (group_id, text, created_at) VALUES (?, ?, ?)');
    for (const t of texts) ins.run(groupId, t, now);
    this.db
      .prepare(
        'DELETE FROM facts WHERE group_id = ? AND id NOT IN (SELECT id FROM facts WHERE group_id = ? ORDER BY id DESC LIMIT ?)',
      )
      .run(groupId, groupId, cap);
  }
}
