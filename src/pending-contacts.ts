/**
 * Pending contacts — file d'attente des contacts inconnus.
 * Stockage dans data/pending-contacts/{jid}.json
 */

import fs from 'fs';
import path from 'path';
import { NewMessage } from './types.js';

const PENDING_DIR = path.join(process.cwd(), 'data', 'pending-contacts');
const MAX_MESSAGES = 20;
const SPAM_THRESHOLD = 8;

export type PendingStatus =
  | 'pending'
  | 'refused'
  | 'awaiting_identity'
  | 'accepted';

export interface PendingMessage {
  content: string;
  timestamp: string;
}

export interface PendingContact {
  jid: string;
  channel: string;
  senderName: string;
  firstSeen: string;
  lastSeen: string;
  messageCount: number;
  messages: PendingMessage[];
  notified: boolean;
  suspectedSpam: boolean;
  status: PendingStatus;
}

function ensureDir(): void {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
}

function filePath(jid: string): string {
  const safe = jid.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(PENDING_DIR, `${safe}.json`);
}

function detectSpam(data: PendingContact, newContent: string): boolean {
  if (data.messageCount >= SPAM_THRESHOLD) return true;
  const recent = data.messages.slice(-5).map((m) => m.content.trim());
  const dupes = recent.filter((c) => c === newContent.trim()).length;
  return dupes >= 2;
}

export function savePendingContact(
  jid: string,
  msg: NewMessage,
): PendingContact {
  ensureDir();
  const fp = filePath(jid);
  let data: PendingContact;
  try {
    data = JSON.parse(fs.readFileSync(fp, 'utf8')) as PendingContact;
  } catch {
    data = {
      jid,
      channel: jid.startsWith('tg:') ? 'telegram' : 'whatsapp',
      senderName: msg.sender_name || msg.sender || jid,
      firstSeen: msg.timestamp,
      lastSeen: msg.timestamp,
      messageCount: 0,
      messages: [],
      notified: false,
      suspectedSpam: false,
      status: 'pending',
    };
  }
  data.lastSeen = msg.timestamp;
  data.messageCount++;
  data.messages.push({ content: msg.content, timestamp: msg.timestamp });
  if (data.messages.length > MAX_MESSAGES) {
    data.messages = data.messages.slice(-MAX_MESSAGES);
  }
  if (!data.suspectedSpam && detectSpam(data, msg.content)) {
    data.suspectedSpam = true;
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  return data;
}

export function getPendingContact(jid: string): PendingContact | null {
  try {
    return JSON.parse(fs.readFileSync(filePath(jid), 'utf8')) as PendingContact;
  } catch {
    return null;
  }
}

export function updatePendingStatus(jid: string, status: PendingStatus): void {
  const data = getPendingContact(jid);
  if (data) {
    data.status = status;
    fs.writeFileSync(filePath(jid), JSON.stringify(data, null, 2));
  }
}

export function markNotified(jid: string): void {
  const data = getPendingContact(jid);
  if (data) {
    data.notified = true;
    fs.writeFileSync(filePath(jid), JSON.stringify(data, null, 2));
  }
}

export function getAllPendingContacts(): PendingContact[] {
  ensureDir();
  try {
    return fs
      .readdirSync(PENDING_DIR)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [
            JSON.parse(
              fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'),
            ) as PendingContact,
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function formatNotification(data: PendingContact): string {
  const ch = data.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const spamWarn = data.suspectedSpam ? '\n⚠️ *Spam suspecté*' : '';
  const preview = data.messages
    .slice(-3)
    .map((m) => `  "${m.content}"`)
    .join('\n');
  return (
    `🔔 *Nouveau contact (${ch})*${spamWarn}\n` +
    `Nom : ${data.senderName}\n` +
    `JID : \`${data.jid}\`\n` +
    `Messages reçus : ${data.messageCount}\n\n` +
    `Aperçu :\n${preview}\n\n` +
    `Répondre :\n*1* — Ignorer (silence total)\n*2* — Lui demander qui il est\n*3* — Accepter`
  );
}
