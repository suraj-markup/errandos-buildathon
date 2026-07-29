#!/usr/bin/env bash
set -euo pipefail

archive="${1:?archive path is required}"
release_id="${2:?release id is required}"
expected_sha="${3:?expected SHA-256 is required}"
release_root="/opt/errandos-brother/web/releases/$release_id"

actual_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "JaldiAI release checksum mismatch." >&2
  exit 1
fi
if [[ ! "$release_id" =~ ^[0-9]{8}T[0-9]{4}$ ]]; then
  echo "JaldiAI release id is invalid." >&2
  exit 1
fi

install -d -m 755 "$release_root"
tar --warning=no-unknown-keyword -xzf "$archive" -C "$release_root"
test -f "$release_root/apps/web/server.js"

ln -sfn "$release_root" /opt/errandos-brother/web/current
systemctl restart jaldiai-web.service

for _ in {1..30}; do
  if curl -fsS -o /dev/null http://127.0.0.1:3100/; then
    break
  fi
  sleep 1
done
curl -fsS -o /dev/null http://127.0.0.1:3100/

credentials="$(</etc/jaldiai/access.txt)"
curl -fsS -o /dev/null -u "$credentials" https://jaldiai.surajmarkup.in/

printf 'JALDIAI_WEB_RELEASE_OK=%s\n' "$release_id"
