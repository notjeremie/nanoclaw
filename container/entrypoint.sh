#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

# Fix musl/glibc binary mismatch in Bun's install cache.
# The SDK ships both musl and glibc binaries but tries musl first.
# On glibc containers (node:22-slim), the musl binary silently fails.
# This copies the glibc binary over the musl path wherever Bun cached it.
for musl_bin in /home/node/.bun/install/cache/@anthropic-ai/claude-agent-sdk-linux-arm64-musl@*/claude; do
  if [ -f "$musl_bin" ]; then
    glibc_bin=$(echo "$musl_bin" | sed 's/-musl//')
    if [ -f "$glibc_bin" ]; then
      cp "$glibc_bin" "$musl_bin" 2>/dev/null && chmod 755 "$musl_bin" 2>/dev/null || true
    fi
  fi
done

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
