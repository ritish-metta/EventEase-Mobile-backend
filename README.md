# OpsEdge

A lightweight web control panel for a Linux server. It runs next to your apps as its own PM2 process, so it keeps working when an app crashes.

**What it does**
- Projects: deploy from git, start / stop / restart / reload, scale, rollback, backups and restore, delete
- Code editor (Monaco) with file tree, terminals, auto save, and one-click Deploy (commit + push)
- Terminal, logs (live), file manager with folder upload / download
- Monitors with auto-heal, alerts (Discord / Slack webhook), charts, health score
- Services, Redis browser, cron jobs, security audit log

## Install on a server

Requirements: Ubuntu (or similar), Node.js 22+, PM2 (`sudo npm i -g pm2`), git.

```bash
git clone <your-opsedge-repo-url> ~/opsedge
cd ~/opsedge
bash install.sh
```

The installer creates `.env` with a random password (`OPS_TOKEN`), installs packages, starts the panel with PM2 as `ops-agent` and saves it so it survives reboots. Then open port 7000 for **your own IP only** and visit `http://<server-ip>:7000`.

For the full terminal (resize support) install build tools before running it: `sudo apt install -y build-essential python3`.

## Update

Automatic: every push to `main` deploys OpsEdge to the server through GitHub Actions (`.github/workflows/deploy.yml`): it clones or updates `~/opsedge`, runs `install.sh` and checks `/api/health`. Set `"enabled": false` in `deploy.json` to pause it. Needed repo secrets: `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`. You can follow each run in the repository's **Actions** tab.

Manual:

```bash
cd ~/opsedge && git pull && bash install.sh
```

## Settings (`.env`)

| Key | Meaning |
| --- | --- |
| `OPS_TOKEN` | Panel password, required |
| `OPS_PORT` | Port, default 7000 |
| `REDIS_URL` | Redis for the Redis page, default `redis://127.0.0.1:6379` |

Runtime data (settings, monitors, metrics history, audit log) is kept in `data/`, backups in `~/ops-backups`. Neither is in git.

## Project layout

```
server.js        API, jobs, PM2 control, terminals
features/        one file per feature (alerts, backups, monitors, redis, cron, security, settings, git access, metrics)
public/          the web UI (index.html, css/, js/)
install.sh       server installer
```
