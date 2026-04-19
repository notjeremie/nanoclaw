#!/bin/bash
# Migrate existing group folders to the new standard structure.
# Creates missing subdirectories and moves files to their proper locations.
# Safe to run multiple times (idempotent).

set -euo pipefail

GROUPS_DIR="$(cd "$(dirname "$0")/.." && pwd)/groups"

echo "Migrating group folders in: $GROUPS_DIR"

# 1. Create standard subdirectories in all groups (skip global)
for group_dir in "$GROUPS_DIR"/*/; do
  group=$(basename "$group_dir")
  [ "$group" = "global" ] && continue
  [ "$group" = "main" ] && continue

  echo "--- $group ---"

  for sub in logs conversations scripts config reports photos attachments; do
    mkdir -p "$group_dir/$sub"
  done

  # Move config/session JSON files to config/
  for f in "$group_dir"/*_config.json "$group_dir"/*-config.json "$group_dir"/*_tokens.json "$group_dir"/*_session.json "$group_dir"/*_auth.json "$group_dir"/*-session.json; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> config/"
    mv "$f" "$group_dir/config/$base"
  done

  # Move snapshot/state files to config/
  for f in "$group_dir"/changelog_snapshot.json "$group_dir"/changelog_last_check.txt; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> config/"
    mv "$f" "$group_dir/config/$base"
  done

  # Move report files to reports/
  for f in "$group_dir"/*.html "$group_dir"/march-shifts-*.md "$group_dir"/shifts-*.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> reports/"
    mv "$f" "$group_dir/reports/$base"
  done

  # Move screenshots/images to photos/ (skip if already in photos/)
  for f in "$group_dir"/*.png "$group_dir"/*.jpg "$group_dir"/*.jpeg; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> photos/"
    mv "$f" "$group_dir/photos/$base"
  done

  # Move loose .js scripts to scripts/ (not package.json)
  for f in "$group_dir"/*.js; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> scripts/"
    mv "$f" "$group_dir/scripts/$base"
  done

  # Move tracking JSON (like molotov-posters.json) to config/
  for f in "$group_dir"/molotov-posters.json; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> config/"
    mv "$f" "$group_dir/config/$base"
  done

  # Move ipc-patch.md to config/
  for f in "$group_dir"/ipc-patch.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> config/"
    mv "$f" "$group_dir/config/$base"
  done

  # Move vps-monitor-status.md to config/
  for f in "$group_dir"/vps-monitor-status.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    echo "  mv $base -> config/"
    mv "$f" "$group_dir/config/$base"
  done

  # Move drafts/ contents to attachments/ if drafts/ exists
  if [ -d "$group_dir/drafts" ] && [ "$(ls -A "$group_dir/drafts" 2>/dev/null)" ]; then
    echo "  mv drafts/* -> attachments/"
    mv "$group_dir"/drafts/* "$group_dir/attachments/" 2>/dev/null || true
    rmdir "$group_dir/drafts" 2>/dev/null || true
  fi
done

echo ""
echo "Done. Now update script paths."
