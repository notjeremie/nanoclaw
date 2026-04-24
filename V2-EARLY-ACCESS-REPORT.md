# NanoClaw v2 Early Access — Upgrade Report

**Source install:** Heavily customized v1 (80 commits ahead of upstream/main @ v1.2.23, forked as `notjeremie/nanoclaw`)
**Target:** `upstream/v2` @ ~v1.2.52 (504 commits ahead of v1)
**Host:** macOS (Apple Silicon), Docker Desktop, Node 22, pnpm 10
**Date:** 2026-04-19 → 2026-04-20

---

## TL;DR

The v2 merge and new entity model worked well. **Six independent container-side issues** blocked the agent from producing any output for several hours until each was diagnosed. Each issue failed silently (no error, 0 SDK events), which made triage slow. Fixing them cleanly would dramatically improve the onboarding experience.

The most impactful fixes — any one of which should probably land upstream — are listed first under **Critical**.

---

## What went well

- **Entity model migration** (flat groups → users/agent_groups/messaging_groups/sessions/messaging_group_agents) is clean. The `/gsd:new-project`-style decomposition makes downstream skills trivial to reason about.
- **Two-DB session split** (`inbound.db` + `outbound.db`) is elegant. Single-writer per file eliminates the lock contention we had on v1. The `seq` parity (even=host, odd=container) is a nice invariant.
- **"Everything is a message"** — dropping IPC in favor of DB polling simplified our custom code significantly. Removing `src/ipc.ts` deleted hundreds of lines of our patches.
- **Channel/provider branches** (`channels`, `providers`) make `/add-telegram`, `/add-whatsapp` etc. feel like proper plugin installs rather than fork-and-merge.
- **Delivery + host-sweep separation**. Easy to reason about wake conditions.
- **Module system** (typing, mount-security, permissions, scheduling, etc.). Clear contract.
- **`/init-first-agent`**, `/manage-channels`, and the new setup flow (once you know what to type) are much better than v1's global-state setup.
- **MCP tool surface** (`send_message`, `schedule_task`, `ask_user_question`, `create_agent`, ...) is well-designed.

## What needed fixing

### Critical — silent failures that blocked every container

1. **Claude Code native binary postinstall skipped**
   - `@anthropic-ai/claude-code` is not in pnpm's `only-built-dependencies` in the base image Dockerfile.
   - Result: `claude --version` works (shows 2.1.112/2.1.114), but every invocation exits 0 with empty stdout.
   - Symptom visible only by running `claude -p 'hi' --output-format json` manually inside the container, which prints:
     ```
     Error: claude native binary not installed.
     Either postinstall did not run (--ignore-scripts, some pnpm configs)
     or the platform-native optional dependency was not downloaded
     ```
   - **Fix:** add `@anthropic-ai/claude-code` to `.npmrc` allowlist before `pnpm install -g` in `container/Dockerfile`.

2. **SDK platform-binary musl/glibc mismatch**
   - `@anthropic-ai/claude-agent-sdk` ships both `claude-agent-sdk-linux-arm64-musl` and `claude-agent-sdk-linux-arm64` optional companion packages.
   - On `node:22-slim` (Debian/glibc), the SDK tries the **musl binary first**. It fails to execute (`cannot execute: required file not found` — no libc.musl-aarch64.so.1 on glibc systems). The SDK silently returns 0 events from the async iterator.
   - Symptom: `[claude-provider] Query completed after 0 SDK messages` for every message.
   - Reproducible every time the image is built; affects all containers.
   - Even the SDK's own runtime error (`Claude Code native binary not found at <musl path>`) is swallowed when `/app/src/` is mounted from the host and Bun uses its install cache instead of `/app/node_modules/`.
   - **Fix options:**
     - (a) Don't ship the musl binary if the image is glibc-based, **or**
     - (b) Have the SDK fall through to the alternate arch package when the musl binary fails with ENOEXEC/ENOENT on the interpreter, **or**
     - (c) Document `pathToClaudeCodeExecutable` as a mandatory option when running under Bun with a mounted `node_modules`.

   In the meantime, we hardcoded `pathToClaudeCodeExecutable: '/pnpm/global/5/node_modules/@anthropic-ai/claude-code/bin/claude.exe'` in the agent-runner's `claude.ts` provider to force the SDK to spawn the globally-installed native binary directly (the SDK detects native binaries and execs them without going through Bun).

3. **`/home/node` not writable by host-UID containers**
   - Container runs as host UID (e.g. `501:dialout` on macOS). `/home/node` is owned by `node:node` (1000). Claude Code writes `/home/node/.claude.json` on first run; on EACCES it exits 0 without any output.
   - Error is visible only with `claude -p 'hi' --verbose --output-format stream-json`:
     ```
     Claude configuration file not found at: /home/node/.claude.json
     A backup file exists at: /home/node/.claude/backups/.claude.json.backup.<ts>
     ```
     (Creating the missing file would write to `/home/node/` which EACCES silently.)
   - **Fix:** `chmod 777 /home/node` in `container/Dockerfile` after `USER node`. Or create `/home/node/.claude.json` as an empty JSON file with group-writable perms. Or mount `.claude.json` explicitly.

4. **OneCLI HTTPS proxy breaks Claude Code's auth flow**
   - OneCLI injects `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY=placeholder` into the container.
   - Placeholder-based x-api-key substitution by the proxy works for direct curl (we verified), but the Claude Code binary hangs during its OAuth token-exchange roundtrip when the proxy is active. It exits 0 without producing output.
   - We do not have a minimal repro with the Claude Code CLI in isolation (would require the OneCLI gateway running, curling the exchange endpoint, and comparing behavior with and without the proxy CA). Flagging it anyway because it cost us hours.
   - **Workaround:** we bypassed OneCLI entirely and inject `ANTHROPIC_API_KEY` read from the macOS Keychain (`Claude Code-credentials` entry, `claudeAiOauth.accessToken`) at container spawn time. This also gives us auto-refreshed tokens for free — OAuth tokens refresh in the keychain, so each spawn picks up the latest token.

### Blockers during setup

5. **`register` step prefixes `platform_id` inconsistently for WhatsApp**
   - `setup/register.ts` auto-prefixes `platform_id` with `<channel>:` (so telegram:123 or whatsapp:123@s.whatsapp.net).
   - The Telegram Chat SDK adapter also uses prefixed IDs, so it works.
   - The native WhatsApp adapter (Baileys) uses **raw JIDs without prefix** (`chatJid = 972...@s.whatsapp.net`) when building its `conversations` Set. The prefix therefore breaks `conversations.has(chatJid)` and every WhatsApp inbound is silently dropped at line ~523 of `src/channels/whatsapp.ts`.
   - **Fix:** either strip the prefix inside the WhatsApp adapter when building the map, or stop adding the prefix in `register.ts` for channels that don't use the Chat SDK bridge.

6. **WhatsApp LIDs (Linked IDs) aren't auto-aliased**
   - WhatsApp's newer clients identify DM senders as `<id>@lid` rather than `<phone>@s.whatsapp.net`.
   - `src/channels/whatsapp.ts`'s `translateJid()` tries `sock.signalRepository.lidMapping.getPNForLID()` and falls back to `msg.key.senderPn`. In practice, for the LID of the bot owner's own account (the phone linked to Baileys), neither path resolves — the chat stays as `@lid` and fails the `conversations.has(chatJid)` check.
   - We had to manually insert a second `messaging_groups` row for the LID, pointing to the same `agent_group_id` as the phone-JID registration.
   - **Fix options:** persist the LID→phone mapping to central DB once resolved, or register both IDs during `register` when the adapter sees a bot-owner LID, or keep a per-group `aliases` column on `messaging_groups`.

7. **Stale `container_status` blocks host-sweep wake**
   - After kill/restart cycles, `sessions.container_status` can be left as `running` even though no container is actually up.
   - `host-sweep.ts` uses this to decide whether to wake a container for due messages (correctly — avoids duplicate spawns).
   - But there's no reconciliation on startup. If the process was SIGKILLed, the column never gets cleared; the sweep then skips forever.
   - **Fix:** on startup, `UPDATE sessions SET container_status='stopped'` (there can't be any live containers from a previous host process since we check `docker ps` for orphans already).

### Functional gaps we noticed

8. **Daemon-style scripts don't fit v2**
   - v1 supported long-running scripts (watchdog daemons, HTTP servers on the group workspace). v2's idle-timeout-then-kill container model breaks these.
   - Not a regression per se — v1's design was leaky (GCs + restart loops). But there's no migration guide.
   - **Suggestion:** doc page on "your v1 daemon → v2 cron task" patterns.

9. **Attachment mount missing**
   - WhatsApp adapter downloads media to `DATA_DIR/attachments/` but the container has no mount to access that path. Agent sees a local path it can't open.
   - We added `mounts.push({ hostPath: path.join(DATA_DIR, 'attachments'), containerPath: '/workspace/attachments', readonly: true })` to `container-runner.ts`.
   - **Fix:** ship this mount by default, or change the adapter to copy into the session folder (already mounted at `/workspace`).

10. **Voice transcription not built in**
    - v1 had an OpenAI Whisper integration in `src/transcription.ts`. Clean to re-add in v2 (adapter calls `transcribeAudio(buffer, filename)` before dispatch; bridge does the same for chat-sdk audio attachments).
    - **Suggestion:** either ship it in the native WhatsApp adapter and the Chat SDK bridge, or document the hook points clearly so users don't reinvent.

11. **v1 task migration is manual**
    - Scheduled tasks in v1 live in `store/messages.db` (`scheduled_tasks` table).
    - In v2 they live as `messages_in` rows with `kind='task'` in each session's `inbound.db`.
    - No migration script ships with v2. Writing one (`scripts/migrate-v1-tasks.mjs` in our fork, 126 lines) was straightforward but easy to mess up.
    - **Suggestion:** `pnpm exec tsx scripts/migrate-v1-tasks.ts` in the `/update-nanoclaw` skill.

12. **`CONTAINER_*` env-var injection dropped**
    - v1's credential proxy passed through `CONTAINER_FOO=bar` in `.env` to the container as `FOO=bar`.
    - v2 doesn't ship this. Everything that used third-party credentials (Google, Plex, LinkedIn, Notion, Gmail via IMAP, etc.) stopped working silently.
    - Could reasonably be replaced by OneCLI hostname-pattern injection — but that requires per-host OneCLI secrets for every service, which is a lot of setup.
    - **Suggestion:** keep the `CONTAINER_*` → stripped-prefix env-passthrough behavior as an opt-in fallback, or provide a mass-import tool from `.env` to OneCLI secrets.

13. **`/workspace/group` path migration**
    - v1 mounted group folders at `/workspace/group/`. v2 mounts at `/workspace/agent/`.
    - All of our scheduled-task prompts (and any external scripts they invoke) have hardcoded `/workspace/group/...` paths.
    - We patched it with a symlink (`ln -sf /workspace/agent /workspace/group` in the container wrapper command).
    - **Suggestion:** ship this compatibility symlink by default, or document explicitly in upgrade guide. The renaming looks cleaner but breaks every v1 user's tasks.

### Nice-to-haves

14. **Orphan agent_groups after `register` errors**
    - `register` creates `agent_groups` rows, wires them, then writes the welcome message. If the welcome-write fails (because the session directory isn't created yet, which happened once in our run — `ENOENT`), the agent_group row persists. Re-running register for the same folder silently adds a duplicate wiring.
    - **Fix:** transaction the entity creation, or write the welcome message last and retry.

15. **`sessions.container_status` could be a computed view from heartbeat mtime**
    - Instead of tracking it as DB state, derive from `/workspace/.heartbeat` mtime. Removes the reconciliation problem entirely.

16. **Module-hook markers are easy to miss**
    - `// MODULE-HOOK:scheduling-pre-task:start` in `poll-loop.ts` is clever but there's no static check that the matching `:end` exists. If someone deletes a module, the orphan block stays.

17. **Silent failure mode everywhere**
    - Almost all the Critical bugs above shared the pattern: "agent starts, runs claude.exe or similar, returns 0 events, `Query completed after 0 SDK messages`".
    - Would strongly suggest that the SDK propagates binary-spawn errors (ENOEXEC, EACCES, ENOENT) as at least one emitted event of `{type:'error', ...}` before the iterator completes. Right now the SDK eats these and the caller can't distinguish "agent had nothing to say" from "agent never ran."

## Summary of changes on our fork

Commits made to get v2 working (in order):
1. `merge: upstream/v2 into main — NanoClaw v2 architecture`
2. `chore: remove v1 dead code after v2 merge` (ipc, credential-proxy, session-commands, transcription, pending-contacts)
3. `feat: install Telegram channel from v2 channels branch`
4. `feat: install WhatsApp channel from v2 channels branch` + pino ESM compat
5. `fix: Claude Code native binary postinstall in container`
6. `fix: use globally-installed Claude binary for SDK (musl/glibc fix)`
7. `fix: make /home/node world-writable for Claude Code config`
8. `fix: SDK musl binary incompatibility + direct credential injection`
9. `feat: voice transcription + shared attachments mount`
10. `feat: migrate v1 scheduled_tasks to v2 messages_in`
11. `feat: inject CONTAINER_*-prefixed env vars into agent containers`
12. `fix: migrate telegram_main scripts + /workspace/group symlink`

Final state: agent works on Telegram and WhatsApp (dedicated bot number), voice transcription via OpenAI Whisper, media readable from `/workspace/attachments/`, 15 migrated cron tasks firing across 5 agent groups, OAuth token auto-refreshed from macOS Keychain at each container spawn, 176 host tests pass.

## Operational feedback

- The iterative failure chain took ~4–5 hours of debugging across two sessions. If the Critical bugs above were fixed upstream, a fresh v2 install from a v1 user would probably take 30 min.
- Documentation-wise: the `/update-nanoclaw` skill + a v1→v2 upgrade guide covering the migration paths (tasks, scripts, `/workspace/group`, `CONTAINER_*` env vars, session auth) would save every future upgrader a day.
- The design quality of v2 is high. The operational readiness is where the gaps are.

Happy to answer questions on any of the above, or test fixes on our setup before release.
