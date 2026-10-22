import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotInfo, ChatMessage, ClientEvent, ServerEvent } from '../../src/shared/protocol';

export type Status = 'connecting' | 'online' | 'offline';

export interface ChatState {
  status: Status;
  you: string | null;
  groupName: string;
  bots: BotInfo[];
  users: string[];
  messages: ChatMessage[];
  /** id pengirim -> nama, untuk yang sedang mengetik */
  typing: Record<string, string>;
  send(text: string): void;
}

export function useChat(name: string | null): ChatState {
  const [status, setStatus] = useState<Status>('connecting');
  const [you, setYou] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!name) return;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        const join: ClientEvent = { type: 'join', name };
        ws.send(JSON.stringify(join));
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data as string) as ServerEvent;
        switch (ev.type) {
          case 'welcome':
            setStatus('online');
            setYou(ev.you);
            setGroupName(ev.group.name);
            setBots(ev.bots);
            setUsers(ev.users);
            setMessages(ev.history);
            setTyping({});
            break;
          case 'message':
            setMessages((m) => (m.some((x) => x.id === ev.message.id) ? m : [...m, ev.message]));
            if (ev.message.kind === 'bot') {
              setTyping((t) => {
                const { [ev.message.senderId]: _gone, ...rest } = t;
                return rest;
              });
            }
            break;
          case 'typing':
            setTyping((t) => {
              if (ev.on) return { ...t, [ev.senderId]: ev.senderName };
              const { [ev.senderId]: _gone, ...rest } = t;
              return rest;
            });
            break;
          case 'presence':
            setUsers(ev.users);
            break;
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus('offline');
        setTyping({});
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [name]);

  const send = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'message', text } satisfies ClientEvent));
  }, []);

  return { status, you, groupName, bots, users, messages, typing, send };
}
