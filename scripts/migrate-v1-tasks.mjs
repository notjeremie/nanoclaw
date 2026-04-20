#!/usr/bin/env node
/**
 * Migrate v1 scheduled_tasks → v2 messages_in (kind='task').
 *
 * v1: store/messages.db → scheduled_tasks (group_folder, cron, prompt, next_run)
 * v2: per-session inbound.db → messages_in row with kind='task', recurrence=cron, process_after=next_run
 *
 * Folder mapping handled by looking up agent_groups.folder in the v2 central DB.
 * Special case: v1 `telegram_main` → v2 `dm-with-jeremie` (same chat: telegram:943752084).
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const ROOT = '/Users/jeremiequenet/nanoclaw';
const V1_DB = path.join(ROOT, 'store/messages.db');
const V2_DB = path.join(ROOT, 'data/v2.db');
const V2_SESSIONS = path.join(ROOT, 'data/v2-sessions');

const FOLDER_MAP = {
  telegram_main: 'dm-with-jeremie',
};

function nextEvenSeq(db) {
  const row = db.prepare('SELECT COALESCE(MAX(seq), -2) AS maxSeq FROM messages_in').get();
  const next = row.maxSeq + 2;
  return next % 2 === 0 ? next : next + 1;
}

const v1 = new Database(V1_DB, { readonly: true });
const v2 = new Database(V2_DB, { readonly: true });

const tasks = v1
  .prepare("SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run FROM scheduled_tasks WHERE status='active'")
  .all();

console.log(`Found ${tasks.length} active v1 tasks`);

let migrated = 0;
let skipped = 0;
const byGroup = {};

for (const task of tasks) {
  const v2Folder = FOLDER_MAP[task.group_folder] || task.group_folder;

  const ag = v2.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(v2Folder);
  if (!ag) {
    console.log(`SKIP: v1 folder "${task.group_folder}" → v2 folder "${v2Folder}" — no matching agent group`);
    skipped++;
    continue;
  }

  const sess = v2.prepare('SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY created_at LIMIT 1').get(ag.id);
  if (!sess) {
    console.log(`SKIP: ${v2Folder} — no session`);
    skipped++;
    continue;
  }

  const inboundPath = path.join(V2_SESSIONS, ag.id, sess.id, 'inbound.db');
  if (!fs.existsSync(inboundPath)) {
    console.log(`SKIP: ${v2Folder} — no inbound.db at ${inboundPath}`);
    skipped++;
    continue;
  }

  const sessDb = new Database(inboundPath);

  // Skip if already migrated (same id)
  const existing = sessDb.prepare('SELECT id FROM messages_in WHERE id = ?').get(task.id);
  if (existing) {
    console.log(`SKIP: ${task.id} already migrated in ${v2Folder}`);
    skipped++;
    sessDb.close();
    continue;
  }

  const recurrence = task.schedule_type === 'cron' ? task.schedule_value : null;
  if (!recurrence) {
    console.log(`SKIP: ${task.id} — non-cron schedule_type "${task.schedule_type}" not supported yet`);
    skipped++;
    sessDb.close();
    continue;
  }

  const [channelType, ...rest] = task.chat_jid.split(':');
  const platformId = rest.join(':');

  const content = JSON.stringify({
    prompt: task.prompt,
    sender: 'system',
    senderId: 'system',
  });

  const seq = nextEvenSeq(sessDb);

  sessDb.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
     VALUES (@id, @seq, datetime('now'), 'pending', 0, @processAfter, @recurrence, 'task', @platformId, @channelType, NULL, @content, @id)`,
  ).run({
    id: task.id,
    seq,
    processAfter: task.next_run,
    recurrence,
    platformId,
    channelType: channelType === 'tg' ? 'telegram' : channelType === 'wa' ? 'whatsapp' : channelType,
    content,
  });

  sessDb.close();

  migrated++;
  byGroup[v2Folder] = (byGroup[v2Folder] || 0) + 1;
  console.log(`OK:   ${v2Folder} — ${recurrence} (next: ${task.next_run})`);
}

console.log(`\n=== Summary ===`);
console.log(`Migrated: ${migrated}`);
console.log(`Skipped:  ${skipped}`);
console.log(`By group:`);
for (const [folder, count] of Object.entries(byGroup)) {
  console.log(`  ${folder}: ${count}`);
}

v1.close();
v2.close();
