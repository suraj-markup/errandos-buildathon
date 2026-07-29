#!/usr/bin/env bash
set -euo pipefail

archive="/tmp/jaldiai-web-20260728T1605.tar.gz"
expected_sha="3fbf0712d3b9c20736704cfccdb9fa2f1ff332a1ce6d23c441609069680138d9"
release_id="20260728T1605"
release_root="/opt/errandos-brother/web/releases/$release_id"
profile_root="/root/.hermes/profiles/brother"
hermes="/root/.local/bin/hermes"
profile_cli="/root/.local/bin/brother"
config_root="/etc/jaldiai"

actual_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "JaldiAI release checksum mismatch." >&2
  exit 1
fi

install -d -m 755 "$release_root" /opt/errandos-brother/bin "$config_root"
tar --warning=no-unknown-keyword -xzf "$archive" -C "$release_root"
install -m 755 /tmp/run-mcp-brother-safe.sh /opt/errandos-brother/bin/run-mcp-safe.sh

if [[ ! -d "$profile_root" ]]; then
  "$hermes" profile create brother \
    --clone-from errandos \
    --description "Private JaldiAI family web profile backed by ErrandOS, with paid final actions disabled."
fi

if [[ ! -x "$profile_cli" ]]; then
  echo "Hermes brother profile alias was not created." >&2
  exit 1
fi

sed -i \
  's#command: /root/product-build-repos/errandos/scripts/run-mcp-secure.sh#command: /opt/errandos-brother/bin/run-mcp-safe.sh#' \
  "$profile_root/config.yaml"

profile_env="$profile_root/.env"
sed -i \
  -e '/^API_SERVER_/d' \
  -e '/^TELEGRAM_/d' \
  -e '/^DISCORD_/d' \
  -e '/^WHATSAPP_/d' \
  -e '/^SLACK_/d' \
  "$profile_env"

api_key_file="$config_root/hermes-api.key"
if [[ ! -s "$api_key_file" ]]; then
  umask 077
  openssl rand -hex 32 > "$api_key_file"
fi
chmod 600 "$api_key_file"
api_key="$(<"$api_key_file")"

{
  printf '\nAPI_SERVER_ENABLED=true\n'
  printf 'API_SERVER_HOST=127.0.0.1\n'
  printf 'API_SERVER_PORT=8643\n'
  printf 'API_SERVER_KEY=%s\n' "$api_key"
} >> "$profile_env"
chmod 600 "$profile_env"

source_web_env="/root/product-build-repos/errandos/apps/web/.env.local"
web_env="$config_root/web.env"
if [[ ! -f "$source_web_env" ]]; then
  echo "Existing Sarvam web environment is unavailable." >&2
  exit 1
fi
install -m 600 "$source_web_env" "$web_env"
sed -i \
  -e '/^HERMES_API_URL=/d' \
  -e '/^HERMES_API_KEY=/d' \
  -e '/^HERMES_MODEL=/d' \
  -e '/^ERRANDOS_PUBLIC_CART_HANDOFF=/d' \
  "$web_env"
{
  printf '\nHERMES_API_URL=http://127.0.0.1:8643\n'
  printf 'HERMES_API_KEY=%s\n' "$api_key"
  printf 'HERMES_MODEL=hermes-agent\n'
  printf 'ERRANDOS_PUBLIC_CART_HANDOFF=true\n'
} >> "$web_env"
chmod 600 "$web_env"

ln -sfn "$release_root" /opt/errandos-brother/web/current

cat > /etc/systemd/system/jaldiai-web.service <<'UNIT'
[Unit]
Description=JaldiAI private family website
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/errandos-brother/web/current/apps/web
EnvironmentFile=/etc/jaldiai/web.env
Environment=NODE_ENV=production
Environment=HOSTNAME=127.0.0.1
Environment=PORT=3100
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

access_file="$config_root/access.txt"
if [[ ! -s "$access_file" ]]; then
  umask 077
  access_password="$(openssl rand -hex 12)"
  printf 'family:%s\n' "$access_password" > "$access_file"
fi
chmod 600 "$access_file"
access_password="$(cut -d: -f2- "$access_file")"
access_hash="$(caddy hash-password --plaintext "$access_password")"

cat > /etc/caddy/jaldiai.caddy <<CADDY
jaldiai.surajmarkup.in {
    basic_auth {
        family $access_hash
    }
    reverse_proxy 127.0.0.1:3100
}
CADDY
chmod 644 /etc/caddy/jaldiai.caddy
if ! grep -qxF 'import /etc/caddy/jaldiai.caddy' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/jaldiai.caddy\n' >> /etc/caddy/Caddyfile
fi

caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now jaldiai-web.service
PATH="/root/.local/bin:$PATH" "$profile_cli" gateway install \
  --force \
  --system \
  --run-as-user root \
  --start-now \
  --start-on-login
systemctl reload caddy

curl -fsS -o /dev/null http://127.0.0.1:3100/
for _ in {1..30}; do
  if curl -fsS -o /dev/null \
    -H "Authorization: Bearer $api_key" \
    http://127.0.0.1:8643/v1/models; then
    break
  fi
  sleep 1
done
curl -fsS -o /dev/null \
  -H "Authorization: Bearer $api_key" \
  http://127.0.0.1:8643/v1/models
curl -fsS -o /dev/null \
  -u "family:$access_password" \
  https://jaldiai.surajmarkup.in/

printf 'JALDIAI_DEPLOYMENT_OK\n'
printf 'URL=https://jaldiai.surajmarkup.in/\n'
printf 'WEB_SERVICE=%s\n' "$(systemctl is-active jaldiai-web.service)"
printf 'HERMES_API_PORT=8643\n'
