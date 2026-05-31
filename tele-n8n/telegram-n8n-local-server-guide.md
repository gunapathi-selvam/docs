# Telegram Bot + n8n + Local Server — Complete Build Reference

A single-file, copy-paste reference for running a Telegram bot wired to an n8n
workflow on a self-hosted local server (your HP i7 / 8GB Xubuntu 24.04 box, with
the Pi 5 as an optional second node later).

Everything here is meant to be run top to bottom. Replace placeholders written
in `<ANGLE_BRACKETS>` with your own values.

---

## 0. The flow in one line

```
Telegram user  ->  Telegram servers  ->  Cloudflare Tunnel  ->  n8n (Docker)  ->  (optional) your app + Postgres
```

- Telegram bot = front-end identity (no code you host).
- n8n = the brain / logic (workflows).
- Cloudflare Tunnel = makes your home server reachable from the internet WITHOUT
  port forwarding (Telegram pushes messages to n8n via webhook, so n8n needs a
  public URL).
- Your app + DB = optional; only when n8n alone isn't enough.

Why a tunnel at all: n8n's Telegram Trigger node uses **webhooks**. Telegram must
be able to reach a public HTTPS URL. A laptop behind your home router has no
public IP, so the tunnel bridges that gap.

---

## 1. Prerequisites (already on your machine, verify anyway)

```bash
# Docker present?
docker --version
docker compose version

# If docker compose plugin missing on Xubuntu 24.04:
sudo apt update
sudo apt install -y docker-compose-plugin

# Make sure your user can run docker without sudo:
sudo usermod -aG docker "$USER"
# log out / back in (or: newgrp docker) for the group change to apply
```

---

## 2. Create the Telegram bot

1. Open Telegram, search for **@BotFather**.
2. Send `/newbot`.
3. Give it a display name, then a username ending in `bot` (e.g. `guna_lab_bot`).
4. BotFather replies with an **API token** that looks like:
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

Keep this token secret — it is the bot's password. Never commit it to git.

Useful BotFather commands afterwards:
- `/setdescription` — text shown before a user starts the bot.
- `/setcommands` — register the slash commands (e.g. `ping - health check`).
- `/token` — re-display or revoke the token.

---

## 3. Project layout on the server

```bash
mkdir -p ~/Projects/n8n
cd ~/Projects/n8n
```

We'll create three files here: `.env`, `docker-compose.yml`, and (optional)
`workflow-ping-pong.json`.

---

## 4. Secrets file (`.env`)

```bash
cat > ~/Projects/n8n/.env << 'EOF'
# Set AFTER you start the tunnel in Step 6 (no trailing path needed beyond the slash)
WEBHOOK_URL=https://CHANGE-ME.trycloudflare.com/

# n8n basic auth (protects the editor UI on your LAN)
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=change-this-strong-password

# Timezone for schedule/cron nodes
GENERIC_TIMEZONE=Asia/Kolkata
TZ=Asia/Kolkata

# Encryption key for stored credentials. Generate once, never change it,
# or you lose access to saved credentials. Generate with:
#   openssl rand -hex 16
N8N_ENCRYPTION_KEY=PASTE-32-CHAR-HEX-HERE
EOF

chmod 600 ~/Projects/n8n/.env   # keep secrets readable only by you
```

Generate the encryption key:

```bash
openssl rand -hex 16
# paste the output into N8N_ENCRYPTION_KEY above
```

---

## 5. Docker Compose for n8n

```yaml
# ~/Projects/n8n/docker-compose.yml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n
    container_name: n8n
    restart: unless-stopped          # survives crashes AND reboots
    ports:
      - "5678:5678"                  # reachable on your LAN at http://<server-ip>:5678
    env_file:
      - .env
    environment:
      - N8N_HOST=localhost
      - N8N_PORT=5678
      - N8N_PROTOCOL=http
      - N8N_RUNNERS_ENABLED=true
    volumes:
      - n8n_data:/home/node/.n8n     # persists workflows, credentials, settings

volumes:
  n8n_data:
```

Start it:

```bash
cd ~/Projects/n8n
docker compose up -d

# follow logs (Ctrl-C to stop following; container keeps running)
docker compose logs -f
```

Open `http://localhost:5678` (or `http://<server-ip>:5678` from another machine).
Log in with the basic-auth user/password from `.env`. Create your owner account
on first launch.

---

## 6. Expose n8n with a Cloudflare Tunnel

### Option A — Quick tunnel (fastest, URL changes each restart)

```bash
# install cloudflared on Ubuntu/Xubuntu
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# start a quick tunnel pointing at n8n
cloudflared tunnel --url http://localhost:5678
```

It prints a line like:

```
https://random-words-here.trycloudflare.com
```

Copy that URL into `WEBHOOK_URL` in `.env` (keep the trailing `/`), then:

```bash
docker compose down && docker compose up -d   # reload env
```

Note: the quick-tunnel URL changes every time you restart `cloudflared`. Fine for
testing; use Option B for anything permanent.

### Option B — Named tunnel (permanent URL, needs a Cloudflare account + domain)

```bash
cloudflared tunnel login                      # opens browser, authorize a domain
cloudflared tunnel create n8n-tunnel          # note the tunnel UUID it prints
cloudflared tunnel route dns n8n-tunnel n8n.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /home/<YOUR-USER>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: n8n.yourdomain.com
    service: http://localhost:5678
  - service: http_status:404
```

Run it as a service so it auto-starts:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Then set `WEBHOOK_URL=https://n8n.yourdomain.com/` in `.env` and restart n8n.

---

## 7. The "ping/pong" workflow (your first milestone)

Goal: send `/ping` to the bot, get `pong` back. This proves the whole loop end
to end.

### 7a. Manual build (reliable — node versions don't matter)

1. In n8n, click **Add workflow**.
2. Add node: search **Telegram Trigger**.
   - Create a new **Telegram API** credential: paste your BotFather token into
     the `Access Token` field. Save.
   - Under `Trigger On`, select `Message`.
3. Add node: **If** (logic node). Connect Telegram Trigger -> If.
   - Condition (String): value 1 = `{{ $json.message.text }}`,
     operation = `equals`, value 2 = `/ping`.
4. Add node: **Telegram** (the action node, not the trigger). Connect the If
   node's `true` output -> Telegram.
   - Resource = `Message`, Operation = `Send Message`.
   - Chat ID = `{{ $json.message.chat.id }}`
   - Text = `pong`
   - Use the same Telegram API credential.
5. Click **Save**, then toggle **Active** (top-right). Activating registers the
   webhook with Telegram automatically (this is why `WEBHOOK_URL` must be correct
   first).
6. In Telegram, send `/ping` to your bot. You should get `pong`.

### 7b. Importable JSON (convenience — adjust if your node versions differ)

In n8n: top-right menu -> **Import from File / Import from URL**, or paste this
via the editor's "Import from clipboard". After import you MUST open each
Telegram node and re-attach your credential (credentials are never exported).

```json
{
  "name": "Telegram Ping Pong",
  "nodes": [
    {
      "parameters": {
        "updates": ["message"],
        "additionalFields": {}
      },
      "id": "trigger-001",
      "name": "Telegram Trigger",
      "type": "n8n-nodes-base.telegramTrigger",
      "typeVersion": 1.2,
      "position": [240, 300],
      "webhookId": "auto-generated-on-save"
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "typeValidation": "strict" },
          "combinator": "and",
          "conditions": [
            {
              "leftValue": "={{ $json.message.text }}",
              "rightValue": "/ping",
              "operator": { "type": "string", "operation": "equals" }
            }
          ]
        }
      },
      "id": "if-001",
      "name": "If /ping",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [480, 300]
    },
    {
      "parameters": {
        "chatId": "={{ $json.message.chat.id }}",
        "text": "pong",
        "additionalFields": {}
      },
      "id": "send-001",
      "name": "Send pong",
      "type": "n8n-nodes-base.telegram",
      "typeVersion": 1.2,
      "position": [720, 220]
    }
  ],
  "connections": {
    "Telegram Trigger": {
      "main": [[{ "node": "If /ping", "type": "main", "index": 0 }]]
    },
    "If /ping": {
      "main": [[{ "node": "Send pong", "type": "main", "index": 0 }]]
    }
  },
  "settings": {},
  "active": false
}
```

If import errors on a `typeVersion`, just lower the number (e.g. `if` to `1`,
`telegram` to `1`) or rebuild manually per 7a — the manual route always works.

---

## 8. Going beyond n8n — calling your own app

When workflow logic outgrows no-code, n8n calls your service via an **HTTP
Request** node. Two minimal receivers below; pick the stack you prefer.

### 8a. Python (FastAPI) receiver

```bash
# on the server
mkdir -p ~/Projects/bot-api && cd ~/Projects/bot-api
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi "uvicorn[standard]"   # inside venv, no --break-system-packages needed
```

> Note: if you ever `pip install` system-wide on Ubuntu 24.04 (outside a venv),
> you must add `--break-system-packages` (PEP 668). Inside the venv above you do
> not.

```python
# ~/Projects/bot-api/main.py
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Incoming(BaseModel):
    chat_id: int
    text: str

@app.post("/handle")
def handle(msg: Incoming):
    # your logic here — DB lookups, calculations, etc.
    reply = f"You said: {msg.text} (len={len(msg.text)})"
    return {"reply": reply}
```

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

In n8n, between the trigger and the send node, add an **HTTP Request** node:
- Method `POST`, URL `http://localhost:8000/handle`
- Body (JSON): `{ "chat_id": {{ $json.message.chat.id }}, "text": "{{ $json.message.text }}" }`
- Then in the Telegram send node, set Text to `{{ $json.reply }}`.

### 8b. Next.js (App Router) API route — fits your frontend stack

```ts
// app/api/handle/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { chat_id, text } = await req.json();
  // your logic here
  const reply = `You said: ${text} (len=${text.length})`;
  return NextResponse.json({ chat_id, reply });
}
```

Run with `npm run dev` (port 3000) or build/start for production. Point the n8n
HTTP Request node at `http://localhost:3000/api/handle`.

### 8c. Adding Postgres (you already run PostgreSQL 16: db `sms_dev`, user `skrillex`)

n8n has a native **Postgres** node — no app needed for simple reads/writes:
- Create a Postgres credential in n8n (host `localhost` won't work from inside the
  container; use `host.docker.internal` or your LAN IP, port `5432`, db `sms_dev`,
  user `skrillex`).
- To let the container reach the host DB, add this to the n8n service in
  `docker-compose.yml`:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then in the Postgres node use host `host.docker.internal`. Note your DB uses peer
auth for `skrillex`; for TCP access from Docker you'll likely need a password
(`md5`/`scram`) auth entry in `pg_hba.conf` for that user over the Docker subnet.

---

## 9. Turning the laptop into a real "always-on" server

A server is just a machine that keeps running services unattended. Four changes:

### 9a. Run with the lid closed (don't sleep)

```bash
sudo nano /etc/systemd/logind.conf
# set / uncomment:
#   HandleLidSwitch=ignore
#   HandleLidSwitchExternalPower=ignore
sudo systemctl restart systemd-logind
```

(Or set the lid action to "Do nothing" in Xubuntu's Power Manager GUI.)

### 9b. Give it a fixed address

In your router's admin page, reserve a DHCP lease binding the laptop's MAC to a
fixed IP (e.g. `192.168.1.50`). Find the MAC with:

```bash
ip link show     # look for the interface's link/ether address
```

### 9c. Prefer wired Ethernet (important for your hardware)

Your WiFi adapter uses the `rtw88_8723de` driver, which is prone to dropouts. A
server you can't reach is useless — plug into Ethernet for the always-on box.
Wired is what you want for a server regardless. (If you must use WiFi, search the
specific dropout workarounds for that driver, e.g. disabling power save and ASPM.)

### 9d. Manage it remotely over SSH (from your Dell)

```bash
# on the server (one time)
sudo apt install -y openssh-server
sudo systemctl enable --now ssh

# from your Dell
ssh skrillex@192.168.1.50
```

Restart policy `unless-stopped` (already in the compose file) brings n8n back
after reboots, so the laptop reboots into a working bot with no intervention.

---

## 10. Optional: the Raspberry Pi 5 as a second node

The Pi 5 (2GB) sips power — good for always-on duty given your 3D printer runs
often and you watch electricity. But 2GB is tight once n8n + a DB share it. Use
the Pi later as a lightweight always-on node (e.g. just `cloudflared`, or a small
service), and keep heavier n8n workflows on the 8GB HP box. Same Docker approach;
on the Pi use the ARM image (the `docker.n8n.io/n8nio/n8n` image is multi-arch, so
the same compose file works).

---

## 11. Everyday operations cheat-sheet

```bash
cd ~/Projects/n8n

docker compose up -d            # start (detached)
docker compose down             # stop and remove container (data persists in volume)
docker compose logs -f          # live logs
docker compose pull             # fetch newer n8n image
docker compose up -d            # apply the update
docker compose restart          # restart after editing .env

# inspect the persistent volume
docker volume inspect n8n_n8n_data

# back up everything (workflows + credentials live in the volume)
docker run --rm -v n8n_n8n_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/n8n-backup-$(date +%F).tar.gz -C /data .
```

Back up regularly — the `N8N_ENCRYPTION_KEY` in `.env` plus the volume together
are what let you restore credentials.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot never responds | Workflow not Active | Toggle Active (top-right); re-check after every restart |
| "webhook not registered" / no messages | Wrong or missing `WEBHOOK_URL` | Set it to the live tunnel URL (trailing `/`), `docker compose down && up -d` |
| Works locally, dies after laptop sleeps | Lid sleep | Step 9a |
| Postgres node can't connect | Container can't see host `localhost` | Use `host.docker.internal` + `extra_hosts` (Step 8c) |
| Lost saved credentials after a move | Encryption key changed | Restore the original `N8N_ENCRYPTION_KEY` |
| Tunnel URL keeps changing | Using quick tunnel | Switch to named tunnel (Step 6B) |
| WiFi drops, server unreachable | `rtw88_8723de` driver | Use Ethernet (Step 9c) |

Verify Telegram's view of your webhook directly:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
```

---

## 13. Where to learn (primary sources first)

- n8n: docs.n8n.io + the official n8n YouTube channel + community.n8n.io forum.
- Telegram Bot API: core.telegram.org/bots (read once to understand tokens/webhooks).
- Self-hosting / homelab: r/selfhosted, the awesome-selfhosted GitHub list;
  video: Techno Tim, NetworkChuck.
- Docker: the official "Docker get started" guide + `docker compose` reference.
- Linux server basics: linuxjourney.com + the Ubuntu Server docs (SSH, systemd,
  permissions).

---

## 14. Milestone checklist

- [ ] Bot created in BotFather, token saved in `.env`
- [ ] `docker compose up -d` running, n8n UI reachable on LAN
- [ ] `cloudflared` tunnel up, `WEBHOOK_URL` set, n8n restarted
- [ ] Ping/pong workflow Active, `/ping` returns `pong`
- [ ] Lid-close + static IP + SSH configured (real server)
- [ ] First backup taken
- [ ] (Later) HTTP Request node calling your own app / Postgres node hitting `sms_dev`

Get steps 1–4 working before touching anything else. Once the loop is solid,
swapping in real logic is just editing the middle.
