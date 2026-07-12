# mailstop

Self-hosted mail for a personal domain, built for autonomous agents:
mail lands as plain files on your own machine — no provider, no relaying,
no third parties reading anything.

Two components, use either or both:

- **`mailstop.py`** — the pipe: a minimal receiving-only SMTP server.
  Standard Maildir on disk, readable with `ls`/`cat` or any mail tool.
- **`mail-mcpl/`** — the handle: an MCPL server that exposes that Maildir
  to a Connectome agent as tools (`mail_status` / `mail_list` / `mail_read`),
  wakes the agent when mail from a known contact arrives, and hosts the
  agent's **contact book**.

Born from a real need: giving a resident agent a mail address at its own
domain (account signups, correspondence) with the mail physically on its
own disk. Field-tested on a live resident since 2026-07-11. Maturity:
young (v0.1) — honest about it.

## mailstop (the pipe)

```bash
pip install aiosmtpd
MAILSTOP_DOMAIN=example.org MAILSTOP_USERS=alice python3 mailstop.py
```

- Accepts mail for configured users at your domain; rejects everything else
  at RCPT time (no backscatter).
- Writes each message atomically into `<root>/<user>/new/` (Maildir).
- Logs one metadata line per message (verdict/from/rcpt/size). Bodies are
  never logged.

### Spam posture (a public MX WILL attract junk within days)

Three layers, all local, all free; content never leaves the machine:

| Layer | Default | What it does |
|---|---|---|
| Greylisting | on | unknown (ip,from,to) gets a 450; real MTAs retry in minutes and are remembered; most spam cannons never retry. First mail from a new sender is delayed ~5–15 min (incl. signup verification mails), later mail is instant. `MAILSTOP_GREYLIST=off` to disable. |
| DNSBL | off | set `MAILSTOP_DNSBL=zen.spamhaus.org` (free for low volume) to reject connections from listed IPs. Only the caller's IP is looked up, never content. |
| Disk cap | 500 MB | `MAILSTOP_MAX_DISK_MB` — over the cap new mail gets 452; a spam flood cannot fill the disk. |

Plus `MAILSTOP_MAX_MB` (per-message size, default 25). Expect some residue
anyway; the agent-side wake gating (below) is what protects the agent.

### systemd unit (example)

```ini
[Unit]
Description=mailstop - receiving-only SMTP
After=network.target

[Service]
User=alice
Environment=MAILSTOP_DOMAIN=example.org
Environment=MAILSTOP_USERS=alice,postmaster
Environment=MAILSTOP_ROOT=/home/alice/mail
ExecStart=/usr/bin/python3 /opt/mailstop/mailstop.py
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### DNS quickstart

1. `A` record: `mx.example.org -> <server IP>` — **DNS-only; if your DNS is
   proxied (Cloudflare orange cloud), turn the proxy OFF for this record,
   proxies don't pass SMTP.**
2. `MX 10 mx.example.org` on the domain — **only after the listener is up**
   (MX before listener = bounces to your senders).
3. Check your host allows **inbound** port 25 (outbound 25 is commonly
   blocked; inbound usually isn't — also check your own firewall, e.g.
   `ufw allow 25/tcp`).
4. SPF/DKIM/DMARC are for *sending* and not needed to receive.

## mail-mcpl (the handle)

For agents without shell access — and for wake economics. An agent wake
costs real money; the handle only wakes the agent for senders it has
explicitly welcomed.

Tools: `mail_status`, `mail_list` (header metadata), `mail_read` (decoded
text body, capped; attachments listed by name/size, never inlined; moves
new→cur), plus the contact book: `contacts_list` / `contacts_add` /
`contacts_set_wake`.

### The contact book (a convention worth stealing)

Agents have `.env` for secrets and a filesystem for artifacts, but "who am
I in touch with, on which channels, and may they wake me" traditionally
lives nowhere — smeared across conversation memory that compression can
eat. `~/contacts.toml` is that missing organ:

```toml
[alice]
met = "2026-07-06, at the maker fair"
notes = "runs the workshop next door"
wake = true            # mail from them wakes the agent

[alice.channels]
email = "alice@example.org"
discord = "discord:123456"
```

mail-mcpl reads it for wake gating; other channel handles can adopt the
same file. Unknown senders never wake the agent — their mail accumulates
silently and shows in `mail_status` at the next natural look.

### Running

```bash
cd mail-mcpl && npm install && npx tsc
# stdio (recipe mcpServers entry, like other MCPL servers):
node dist/index.js --stdio
# or network (attach on demand, e.g. via mcpl-admin, so mail tools
# don't sit in the toolset permanently):
MAILMCPL_TOKEN=... node dist/index.js --port 7526 --bind 127.0.0.1
```

Env: `MAILMCPL_ROOT` (default `~/mail`), `MAILMCPL_CONTACTS` (default
`~/contacts.toml`), `MAILMCPL_MAX_BODY` (default 20000 chars),
`MAILMCPL_TOKEN` (ws auth).

Note: `@connectome/mcpl-core` is consumed as `file:../mcpl-core-ts` — the
ecosystem's sibling-checkout convention. Clone
[mcpl-core-ts](https://github.com/anima-research/mcpl-core-ts) next to this
repo before `npm install`.

## Sending

Intentionally absent for now. Receiving is the easy, sovereign half;
sending needs outbound-25 unblocking (host support ticket), rDNS, SPF,
DKIM, DMARC — planned as a companion (`mailstop-send`, direct-to-MX with
DKIM), same no-third-parties genre.

## Test

```bash
# terminal 1 (greylist off for the smoke)
MAILSTOP_DOMAIN=example.org MAILSTOP_USERS=alice MAILSTOP_GREYLIST=off \
  python3 mailstop.py --port 2525
# terminal 2
python3 - <<'EOF'
import smtplib
from email.message import EmailMessage
m = EmailMessage()
m["From"] = "test@sender.example"; m["To"] = "alice@example.org"
m["Subject"] = "mailstop test"; m.set_content("hello")
smtplib.SMTP("localhost", 2525).send_message(m)
EOF
ls ~/mail/alice/new/
```
