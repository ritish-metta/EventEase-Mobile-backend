#!/usr/bin/env bash
# OpsEdge installer: run inside the cloned opsedge folder on the server.
#   git clone <your-opsedge-repo> ~/opsedge && cd ~/opsedge && bash install.sh
# Needs Node.js 22+ and PM2 (npm i -g pm2). Safe to run again: it keeps an existing .env.
set -euo pipefail

cd "$(dirname "$0")"

command -v node >/dev/null || { echo "Node.js 22+ is required"; exit 1; }
command -v pm2 >/dev/null || { echo "PM2 is required: sudo npm i -g pm2"; exit 1; }

# 1. settings: create .env with a random password the first time
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^OPS_TOKEN=.*/OPS_TOKEN=$(openssl rand -hex 24)/" .env
  echo "Created .env with a new random OPS_TOKEN"
fi

# 2. packages (node-pty needs build tools for the full terminal; it is optional)
npm ci --omit=dev --no-audit --no-fund

# 3. run under PM2 and keep it after reboots
#    (an old ops-agent started from another folder is replaced, a matching one is reloaded)
HERE="$(pwd)/server.js"
RUNNING=$(pm2 jlist 2>/dev/null | node -e "
  let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
    try { const p = JSON.parse(s.slice(s.indexOf('['))).find((x) => x.name === 'ops-agent'); console.log(p ? p.pm2_env.pm_exec_path : ''); }
    catch { console.log(''); }
  });")
if [ "$RUNNING" = "$HERE" ]; then
  pm2 reload ops-agent
else
  [ -n "$RUNNING" ] && pm2 delete ops-agent
  pm2 start server.js --name ops-agent
fi
pm2 save

PORT=$(grep -E '^OPS_PORT=' .env | cut -d= -f2)
echo
echo "OpsEdge is running on port ${PORT:-7000}."
# only show the password in a real terminal, never in CI logs
if [ -t 1 ]; then
  echo "Password (OPS_TOKEN): $(grep -E '^OPS_TOKEN=' .env | cut -d= -f2)"
else
  echo "Password: run  grep OPS_TOKEN $(pwd)/.env  on the server."
fi
echo "Open the port in your firewall / security group for your own IP only."
