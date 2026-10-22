import { FormEvent, useEffect, useRef, useState } from 'react';
import { useChat } from './useChat';

const KEY = 'gcai:name';

function Join({ onJoin }: { onJoin: (name: string) => void }) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      localStorage.setItem(KEY, n);
    } catch {
      /* abaikan */
    }
    onJoin(n);
  };
  return (
    <form className="join" onSubmit={submit}>
      <h1>Group Chat AI</h1>
      <p>Masuk ke grup dan ngobrol bareng para bot.</p>
      <input autoFocus placeholder="Nama kamu" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={!name.trim()}>Masuk</button>
    </form>
  );
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

function Chat({ name }: { name: string }) {
  const chat = useChat(name);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const colors = Object.fromEntries(chat.bots.map((b) => [b.id, b.color]));
  const typingNames = Object.values(chat.typing);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages.length, typingNames.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    chat.send(t);
    setText('');
  };

  return (
    <div className="chat">
      <header>
        <div>
          <strong>{chat.groupName || 'Grup'}</strong>
          <small>
            {[...chat.bots.map((b) => b.name), ...chat.users].join(', ')}
          </small>
        </div>
        <span className={`dot ${chat.status}`} title={chat.status} />
      </header>
      {chat.status === 'offline' && <div className="banner">Terputus, mencoba menyambung lagi…</div>}
      <main>
        {chat.messages.map((m) => {
          const mine = m.kind === 'user' && m.senderName === chat.you;
          return (
            <div key={m.id} className={`row ${mine ? 'mine' : ''}`}>
              <div className="bubble">
                {!mine && (
                  <span className="who" style={{ color: m.kind === 'bot' ? colors[m.senderId] : '#667' }}>
                    {m.senderName}
                  </span>
                )}
                <span>{m.text}</span>
                <time>{time(m.ts)}</time>
              </div>
            </div>
          );
        })}
        {typingNames.length > 0 && (
          <div className="typing">
            {typingNames.join(', ')} sedang mengetik<span className="dots"><i /><i /><i /></span>
          </div>
        )}
        <div ref={endRef} />
      </main>
      <form className="composer" onSubmit={submit}>
        <input
          autoFocus
          placeholder="Ketik pesan…"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
        />
        <button disabled={!text.trim() || chat.status !== 'online'}>Kirim</button>
      </form>
    </div>
  );
}

export function App() {
  const [name, setName] = useState<string | null>(null);
  return name ? <Chat name={name} /> : <Join onJoin={setName} />;
}
