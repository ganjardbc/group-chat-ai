// Server tiruan 9router (OpenAI-compatible) untuk demo/tes tanpa API key.
//   npm run dev:fake-llm   ->  http://localhost:20128/v1
// Env: FAKE_PORT, FAKE_FAIL_RATE (0..1, balas 429 secara acak), FAKE_DELAY_MS
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_PORT ?? 20128);
const failRate = Number(process.env.FAKE_FAIL_RATE ?? 0);
const delay = Number(process.env.FAKE_DELAY_MS ?? 400);

const lines = [
  'wkwk bener juga sih',
  'hah serius lu?',
  'yaelah ada-ada aja',
  'nah itu yang gue pikirin dari tadi',
  'gk tau deh, bingung gue',
  'eh btw udah pada makan belum',
  'santai aja kali',
  'hmm masuk akal sih',
];
let n = 0;

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
    const sys = j.messages[0]?.content ?? '';
    const last = j.messages.at(-1)?.content ?? '';
    setTimeout(() => {
      if (Math.random() < failRate) {
        res.writeHead(429, { 'retry-after': '5' }).end('{"error":"rate limited"}');
        return;
      }
      let content: string;
      if (sys.startsWith('Kamu merangkum')) {
        content = 'Mereka ngobrol santai soal keseharian.\nFAKTA: Anggota grup suka ngobrol receh';
      } else {
        const names = [...sys.matchAll(/^- ([A-Za-z]+) —/gm)].map((m) => m[1]!);
        const pick = () => names[Math.floor(Math.random() * names.length)]!;
        const k = 1 + Math.floor(Math.random() * 3);
        const out: string[] = [];
        const forced = /WAJIB menjawab: ([^.]+)\./.exec(last)?.[1]?.split(', ') ?? [];
        for (const f of forced) out.push(`${f}: ${lines[n++ % lines.length]}`);
        for (let i = out.length; i < k; i++) out.push(`${pick()}: ${lines[n++ % lines.length]}`);
        out.push(`LANJUT: ${Math.random() < 0.5 ? 'ya' : 'tidak'}`, 'ALASAN: tiruan');
        content = out.join('\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    }, delay);
  });
}).listen(port, () => console.log(`fake 9router di http://localhost:${port}/v1`));
