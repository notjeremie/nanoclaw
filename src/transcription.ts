import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
	logger.warn('OPENAI_API_KEY not set — voice transcription unavailable');
	return null;
  }

  const tmpPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
	const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
	const fileData = fs.readFileSync(tmpPath);
	const body = Buffer.concat([
	  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
	  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`),
	  fileData,
	  Buffer.from(`\r\n--${boundary}--\r\n`),
	]);

	const transcript = await new Promise<string>((resolve, reject) => {
	  const req = https.request({
		hostname: 'api.openai.com',
		path: '/v1/audio/transcriptions',
		method: 'POST',
		headers: {
		  'Authorization': `Bearer ${apiKey}`,
		  'Content-Type': `multipart/form-data; boundary=${boundary}`,
		  'Content-Length': body.length,
		},
	  }, (res) => {
		let data = '';
		res.on('data', (chunk) => data += chunk);
		res.on('end', () => {
		  try {
			const json = JSON.parse(data);
			if (json.text) resolve(json.text);
			else reject(new Error(json.error?.message || 'No transcript'));
		  } catch (e) { reject(e); }
		});
	  });
	  req.on('error', reject);
	  req.write(body);
	  req.end();
	});

	logger.info({ chars: transcript.length }, 'Transcribed voice message');
	return transcript;
  } catch (err) {
	logger.error({ err }, 'OpenAI transcription failed');
	return null;
  } finally {
	fs.unlinkSync(tmpPath);
  }
}