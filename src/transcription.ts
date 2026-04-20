/**
 * Voice note transcription via OpenAI Whisper API.
 * Called by channel adapters before the voice note reaches the agent,
 * so the agent sees text, not an audio file.
 */
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { log } from './log.js';

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
    log.warn('OPENAI_API_KEY not set — voice transcription unavailable');
    return null;
  }

  const tmpPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    const boundary = '----NanoClaw' + Date.now();
    const fileBuffer = fs.readFileSync(tmpPath);
    const fileExt = path.extname(filename).slice(1) || 'ogg';
    const contentType = fileExt === 'mp3' ? 'audio/mpeg' : `audio/${fileExt}`;

    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`));
    parts.push(Buffer.from(`Content-Type: ${contentType}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n`));
    parts.push(Buffer.from(`whisper-1\r\n`));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    return await new Promise<string | null>((resolve) => {
      const req = https.request(
        {
          hostname: 'api.openai.com',
          port: 443,
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
          timeout: 30_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode === 200 && parsed.text) {
                resolve(parsed.text.trim());
              } else {
                log.error('OpenAI transcription failed', { status: res.statusCode, error: parsed.error });
                resolve(null);
              }
            } catch (err) {
              log.error('Failed to parse transcription response', { err, data });
              resolve(null);
            }
          });
        },
      );
      req.on('error', (err) => {
        log.error('OpenAI transcription request error', { err });
        resolve(null);
      });
      req.on('timeout', () => {
        log.error('OpenAI transcription timeout');
        req.destroy();
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}
