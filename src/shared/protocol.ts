// Tipe bersama server <-> frontend (type-only, tanpa dependensi runtime).

export type SenderKind = 'user' | 'bot';

export interface ChatMessage {
  id: number;
  groupId: string;
  senderId: string;
  senderName: string;
  kind: SenderKind;
  text: string;
  ts: number;
}

export interface BotInfo {
  id: string;
  name: string;
  color: string;
  bio: string;
}

export type ClientEvent =
  | { type: 'join'; name: string }
  | { type: 'message'; text: string };

export type ServerEvent =
  | {
      type: 'welcome';
      you: string;
      group: { id: string; name: string };
      bots: BotInfo[];
      history: ChatMessage[];
      users: string[];
    }
  | { type: 'message'; message: ChatMessage }
  | { type: 'typing'; senderId: string; senderName: string; on: boolean }
  | { type: 'presence'; users: string[] };
