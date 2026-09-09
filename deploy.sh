#!/usr/bin/env bash
# Ship the sniper to a fresh Ubuntu box and leave it running under systemd.
#
#   ./deploy.sh <ip> <path-to-key.pem>
#
# Safe to run repeatedly — it redeploys and restarts. The .env goes over
# separately with tight permissions and is never baked into anything.

set -euo pipefail

IP="${1:?usage: ./deploy.sh <ip> <key.pem>}"
KEY="${2:?usage: ./deploy.sh <ip> <key.pem>}"
REMOTE="ubuntu@${IP}"
SSH="ssh -i ${KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=15"
APP=/opt/laptop-sniper

chmod 600 "$KEY" 2>/dev/null || true

echo "→ checking the box"
$SSH "$REMOTE" "uname -sm && echo reachable"

echo "→ installing node if it is missing"
$SSH "$REMOTE" 'command -v node >/dev/null || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y nodejs >/dev/null 2>&1
}; node -v'

echo "→ copying source"
$SSH "$REMOTE" "sudo mkdir -p ${APP} && sudo chown ubuntu:ubuntu ${APP}"
# Everything the SERVER owns and this machine does not must be excluded, or
# --delete quietly wipes it on every deploy: the wallets, who to alert, and
# whether it is armed. Losing the arm state at 12:58 would be silent and fatal.
rsync -az --delete \
  --exclude node_modules --exclude .git \
  --exclude .env --exclude .wallets.json \
  --exclude .chats.json --exclude .armed.json \
  -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  ./ "${REMOTE}:${APP}/"

echo "→ copying .env  (kept out of rsync so --delete can never touch it)"
scp -q -i "$KEY" -o StrictHostKeyChecking=no .env "${REMOTE}:${APP}/.env"
$SSH "$REMOTE" "chmod 600 ${APP}/.env"

# The wallet file only moves if one exists here and none exists there. Keys are
# generated per machine, and overwriting the server's file would strand funds.
if [ -f .wallets.json ]; then
  if $SSH "$REMOTE" "[ ! -f ${APP}/.wallets.json ]"; then
    echo "→ copying wallets (server had none)"
    scp -q -i "$KEY" -o StrictHostKeyChecking=no .wallets.json "${REMOTE}:${APP}/.wallets.json"
    $SSH "$REMOTE" "chmod 600 ${APP}/.wallets.json"
  else
    echo "→ server already has wallets, leaving them alone"
  fi
fi

echo "→ installing dependencies"
$SSH "$REMOTE" "cd ${APP} && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1; echo done"

echo "→ installing the service"
$SSH "$REMOTE" "sudo tee /etc/systemd/system/laptop-sniper.service >/dev/null <<'UNIT'
[Unit]
Description=LAPTOP sniper — Base
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${APP}
EnvironmentFile=${APP}/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=laptop-sniper

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable laptop-sniper >/dev/null 2>&1
sudo systemctl restart laptop-sniper
sleep 4
sudo systemctl is-active laptop-sniper"

echo
echo "→ live. last few lines:"
$SSH "$REMOTE" "sudo journalctl -u laptop-sniper -n 20 --no-pager | tail -20"
echo
echo "watch it:   ssh -i ${KEY} ${REMOTE} 'sudo journalctl -u laptop-sniper -f'"
echo "restart:    ssh -i ${KEY} ${REMOTE} 'sudo systemctl restart laptop-sniper'"
