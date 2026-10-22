import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { BotInfo, ChatMessage, ClientEvent, ServerEvent } from '../../shared/protocol.js';
import type { Logger } from '../logger.js';
import type { Memory } from '../memory/memory.js';
import type { Persona } from '../persona/persona.js';

export interface GatewayDeps {
  group: { id: string; name: string };
  bots: Persona[];
  memory: Memory;
  webDir: string;
  log: Logger;
  /** Dipanggil setelah pesan pengguna tersimpan dan disiarkan. */
  onUserMessage(msg: ChatMessage): void;
  onUserJoin(): void;
  historySize?: number;
  now?: () => number;
}

interface Client {
  ws: WebSocket;
  name: string | null;
  recent: number[];
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const MAX_TEXT = 500;

export function sanitizeName(raw: unknown, bots: Persona[]): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name) return null;
  if (bots.some((b) => b.name.toLowerCase() === name.toLowerCase() || b.id === name.toLowerCase())) name += ' (manusia)';
  return name;
}

export class Gateway {
  readonly server: Server;
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private readonly now: () => number;

  constructor(private readonly d: GatewayDeps) {
    this.now = d.now ?? Date.now;
    this.server = createServer((req, res) => this.serveHttp(req.url ?? '/', res));
    this.wss = new WebSocketServer({ server: this.server, path: '/ws', maxPayload: 8 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  listen(port: number): Promise<number> {
    return new Promise((resolveP) => {
      this.server.listen(port, () => {
        const addr = this.server.address();
        resolveP(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Jumlah klien yang sudah join; timer idle Director hanya jalan jika > 0. */
  get joinedCount(): number {
    return [...this.clients].filter((c) => c.name).length;
  }

  broadcastMessage(message: ChatMessage) {
    this.broadcast({ type: 'message', message });
  }

  broadcastTyping(senderId: string, senderName: string, on: boolean) {
    this.broadcast({ type: 'typing', senderId, senderName, on });
  }

  // ───────────────────────── internal ─────────────────────────

  private users(): string[] {
    return [...new Set([...this.clients].map((c) => c.name).filter((n): n is string => Boolean(n)))];
  }

  private send(ws: WebSocket, ev: ServerEvent) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  }

  private broadcast(ev: ServerEvent) {
    const data = JSON.stringify(ev);
    for (const c of this.clients) if (c.name && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, name: null, recent: [] };
    this.clients.add(client);

    ws.on('message', (data) => {
      let ev: ClientEvent;
      try {
        ev = JSON.parse(data.toString()) as ClientEvent;
      } catch {
        return;
      }
      if (ev.type === 'join') this.handleJoin(client, ev.name);
      else if (ev.type === 'message') this.handleMessage(client, ev.text);
    });
    ws.on('close', () => {
      this.clients.delete(client);
      if (client.name) this.broadcast({ type: 'presence', users: this.users() });
    });
    ws.on('error', () => ws.terminate());
  }

  private handleJoin(c: Client, rawName: unknown) {
    if (c.name) return;
    const name = sanitizeName(rawName, this.d.bots);
    if (!name) return;
    c.name = name;
    this.d.onUserJoin();

    const bots: BotInfo[] = this.d.bots.map((b) => ({ id: b.id, name: b.name, color: b.color, bio: b.bio }));
    this.send(c.ws, {
      type: 'welcome',
      you: name,
      group: this.d.group,
      bots,
      history: this.d.memory.store.recent(this.d.group.id, this.d.historySize ?? 50),
      users: this.users(),
    });
    this.broadcast({ type: 'presence', users: this.users() });
  }

  private handleMessage(c: Client, rawText: unknown) {
    if (!c.name || typeof rawText !== 'string') return;
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) return;

    // anti-flood sederhana: maks 6 pesan per 10 detik per koneksi
    const t = this.now();
    c.recent = c.recent.filter((x) => t - x < 10_000);
    if (c.recent.length >= 6) return;
    c.recent.push(t);

    const msg = this.d.memory.store.addMessage({
      groupId: this.d.group.id, senderId: `user:${c.name}`, senderName: c.name, kind: 'user', text, ts: t,
    });
    this.broadcastMessage(msg);
    this.d.onUserMessage(msg);
  }

  private serveHttp(url: string, res: import('node:http').ServerResponse) {
    const path = decodeURIComponent(url.split('?')[0] ?? '/');
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, users: this.users().length }));
      return;
    }
    const root = resolve(this.d.webDir);
    let file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html'); // SPA fallback
    if (!existsSync(file)) {
      res
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Frontend belum dibuild. Jalankan `npm run build:web` atau `npm run dev:web`.');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  }
}
