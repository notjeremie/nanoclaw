import path from 'path';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';
import { transcribeAudio } from '../transcription.js';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';

const WA_PREFIX = 'wa:';
const AUTH_DIR = path.join(DATA_DIR, 'whatsapp-auth');

function toWaJid(jid: string): string {
  return jid.replace(WA_PREFIX, '');
}

function fromWaJid(jid: string): string {
  return `${WA_PREFIX}${jid}`;
}

class WhatsAppChannel implements Channel {
  name = 'whatsapp';
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private _connected = false;
  private onMessage: ChannelOpts['onMessage'];
  private onChatMetadata: ChannelOpts['onChatMetadata'];
  private phoneNumber: string;
  private pairingCodeRequested = false;
  private authKeys: any = null;

  constructor(opts: ChannelOpts, phoneNumber: string) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.phoneNumber = phoneNumber;
  }

  async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    this.authKeys = state.keys;
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      // Silence Baileys' internal logger — NanoClaw's logger handles it
      logger: logger.child({ level: 'silent', channel: 'baileys' }) as any,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // When a QR is generated and device isn't registered yet,
      // request a pairing code instead (no QR scanning needed)
      if (qr && !this.pairingCodeRequested && !state.creds.registered) {
        this.pairingCodeRequested = true;
        try {
          const code = await this.sock!.requestPairingCode(
            this.phoneNumber.replace('+', ''),
          );
          logger.info({ code }, 'WhatsApp pairing code ready');
          console.log('\n╔══════════════════════════════╗');
          console.log('║   WhatsApp Pairing Code      ║');
          console.log(`║   ${code}   ║`);
          console.log('╚══════════════════════════════╝');
          console.log('WhatsApp → Settings → Linked Devices → Link a Device\n');
        } catch (err) {
          logger.error({ err }, 'Failed to get WhatsApp pairing code');
        }
      }

      if (connection === 'open') {
        this._connected = true;
        logger.info('WhatsApp connected ✓');
      }

      if (connection === 'close') {
        this._connected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.info({ statusCode, shouldReconnect }, 'WhatsApp disconnected');
        if (shouldReconnect) {
          setTimeout(() => this.connect(), 5000);
        }
      }
    });

    this.sock.ev.process(async (events) => {
      if (events['messages.upsert']) {
        const { messages, type } = events['messages.upsert'];
        logger.info(
          { type, count: messages.length },
          'WA messages.upsert received',
        );
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
          if (msg.key.fromMe || !msg.message) continue;

          const remoteJid = msg.key.remoteJid!;
          let chatJid = fromWaJid(remoteJid);
          if (remoteJid.endsWith('@lid') && this.authKeys) {
            const lidUser = remoteJid.split('@')[0];
            const stored = await this.authKeys.get('lid-mapping', [
              `${lidUser}_reverse`,
            ]);
            const pnUser = stored[`${lidUser}_reverse`];
            if (pnUser) chatJid = `${WA_PREFIX}${pnUser}@s.whatsapp.net`;
          }
          const participant = msg.key.participant || remoteJid;
          const senderId = fromWaJid(jidNormalizedUser(participant));

          let text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption ||
            (msg.message.imageMessage ? '[Image]' : '') ||
            (msg.message.videoMessage ? '[Video]' : '') ||
            (msg.message.documentMessage
              ? `[Document: ${msg.message.documentMessage.fileName || 'fichier'}]`
              : '') ||
            '';

          // Prepend trigger if bot is @mentioned
          const mentionedJids: string[] =
            msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const botPhoneJid = `${this.phoneNumber}@s.whatsapp.net`;

          let isBotMentioned = mentionedJids.some(
            (jid) => jidNormalizedUser(jid) === jidNormalizedUser(botPhoneJid),
          );

          // WhatsApp groups use LID format for mentions — resolve via auth mapping
          if (!isBotMentioned && this.authKeys) {
            for (const jid of mentionedJids) {
              if (jid.endsWith('@lid')) {
                const lidUser = jid.split('@')[0];
                const stored = await this.authKeys.get('lid-mapping', [
                  `${lidUser}_reverse`,
                ]);
                const pnUser = stored[`${lidUser}_reverse`];
                if (
                  pnUser &&
                  jidNormalizedUser(`${pnUser}@s.whatsapp.net`) ===
                    jidNormalizedUser(botPhoneJid)
                ) {
                  isBotMentioned = true;
                  break;
                }
              }
            }
          }

          if (isBotMentioned && !TRIGGER_PATTERN.test(text.trim())) {
            text = `@${ASSISTANT_NAME} ${text}`;
          }

          if (!text && msg.message.audioMessage?.ptt) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const transcript = await transcribeAudio(
                buffer as Buffer,
                `wa-voice-${msg.key.id}.ogg`,
              );
              if (transcript) text = transcript;
            } catch (err) {
              logger.error({ err }, 'Failed to transcribe voice message');
            }
          }

          if (!text) continue;

          this.onChatMetadata(
            chatJid,
            new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
            msg.pushName || undefined,
            'whatsapp',
            isJidGroup(remoteJid),
          );

          this.onMessage(chatJid, {
            id: msg.key.id || `wa-${Date.now()}`,
            chat_jid: chatJid,
            sender: senderId,
            sender_name: msg.pushName || senderId,
            content: text,
            timestamp: new Date(
              Number(msg.messageTimestamp) * 1000,
            ).toISOString(),
          });
        }
      }
    });

    // Sync chat names when available
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock || !this._connected) {
      throw new Error('WhatsApp not connected');
    }
    await this.sock.sendMessage(toWaJid(jid), { text });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.sock || !this._connected) return;
    await this.sock.sendPresenceUpdate(
      isTyping ? 'composing' : 'paused',
      toWaJid(jid),
    );
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WA_PREFIX);
  }

  async disconnect(): Promise<void> {
    await this.sock?.end(undefined);
    this.sock = null;
    this._connected = false;
  }
}

registerChannel('whatsapp', (opts) => {
  const env = readEnvFile(['WA_PHONE_NUMBER']);
  const phoneNumber = env.WA_PHONE_NUMBER;

  if (!phoneNumber) {
    logger.info('WA_PHONE_NUMBER not set — WhatsApp channel disabled');
    return null;
  }

  return new WhatsAppChannel(opts, phoneNumber);
});
