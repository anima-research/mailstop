#!/usr/bin/env python3
"""mailstop — a minimal receiving-only SMTP server for a personal domain.

Accepts mail for configured recipients and writes each message to a
per-recipient Maildir. No relaying, no sending, no third parties: mail
lands as files on the machine that runs this.

Typical use: give an agent (or a human) a real inbox at their own domain
for account signups and correspondence, without a mail provider.

Usage:
  MAILSTOP_DOMAIN=example.org MAILSTOP_USERS=alice,bob \
      python3 mailstop.py [--port 25] [--bind 0.0.0.0] [--root ~/mail]

Config (env or flags; flags win):
  MAILSTOP_DOMAIN   domain to accept mail for (required)
  MAILSTOP_USERS    comma-separated local users; "*" = catch-all (required)
  MAILSTOP_ROOT     storage root, default ~/mail (Maildir per recipient)
  MAILSTOP_MAX_MB   max message size in MB, default 25
  MAILSTOP_MAX_DISK_MB  cap on total Maildir size; new mail is rejected
                        (452) once exceeded, so a spam flood cannot fill
                        the disk. Default 500.
  MAILSTOP_GREYLIST     "on" (default) / "off". Unknown (ip,from,to) triples
                        get a temporary 450 reject; real MTAs retry within
                        minutes and are then accepted (and remembered),
                        most spam cannons never retry. First mail from a
                        new sender is delayed ~5-15 min; later mail is
                        instant. State: <root>/.greylist.json
  MAILSTOP_DNSBL        DNSBL zone to check connecting IPs against
                        (e.g. zen.spamhaus.org; free for low volume).
                        Empty (default) = disabled. Only the caller's IP
                        leaves the machine, never mail content.

Storage layout (standard Maildir, readable by any mail tool or plain ls):
  <root>/<user>/new/<timestamp>.<unique>.eml

Log: one metadata line per accepted/rejected message to stderr —
timestamp, verdict, from, rcpt, size. Bodies are never logged.

Requires: python3 >= 3.9, aiosmtpd (pip install aiosmtpd).
DNS: point the domain's MX at this host. SPF/DKIM are for SENDING and are
not needed to receive. Most senders use opportunistic TLS and fall back to
plain if STARTTLS is absent; enable TLS later by fronting with a cert if
your senders require it.
"""
import argparse
import ipaddress
import json
import asyncio
import email.utils
import os
import socket
import sys
import time
from pathlib import Path

try:
    from aiosmtpd.controller import Controller
except ImportError:
    sys.exit("mailstop: aiosmtpd is required (pip install aiosmtpd)")


GREYLIST_PASS_AFTER = 60       # seconds an unknown triple must wait before retry counts
GREYLIST_REMEMBER = 35 * 86400  # seconds a passed sender stays known


class Greylist:
    """Persisted (ip, from, to) triple store for greylisting."""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict = {}
        try:
            if path.exists():
                self.data = json.loads(path.read_text())
        except Exception:
            self.data = {}

    def check(self, ip: str, mail_from: str, rcpt: str) -> bool:
        """True = accept, False = temporary reject (450)."""
        now = time.time()
        key = f"{ip}|{mail_from.lower()}|{rcpt.lower()}"
        rec = self.data.get(key)
        if rec is None:
            self.data[key] = {"first": now, "passed": False}
            self._save()
            return False
        if rec.get("passed") or now - rec["first"] >= GREYLIST_PASS_AFTER:
            rec["passed"] = True
            rec["last"] = now
            self._save()
            return True
        return False

    def _save(self) -> None:
        # opportunistic pruning + write; never raise into the SMTP path
        try:
            now = time.time()
            self.data = {k: v for k, v in self.data.items()
                         if now - v.get("last", v["first"]) < GREYLIST_REMEMBER}
            self.path.write_text(json.dumps(self.data))
        except Exception:
            pass


def dnsbl_listed(ip: str, zone: str) -> bool:
    """True if `ip` is listed in the DNSBL `zone`. Fails open (unlisted) on
    any resolution error; only the caller IP is sent, never content."""
    try:
        addr = ipaddress.ip_address(ip)
        if addr.version != 4:
            return False  # v6 DNSBL formatting omitted in v0.1
        query = ".".join(reversed(ip.split("."))) + "." + zone
        socket.setdefaulttimeout(5)
        socket.gethostbyname(query)
        return True   # any A answer = listed
    except OSError:
        return False


def dir_size_mb(root: Path) -> float:
    total = 0
    try:
        for p in root.rglob("*"):
            if p.is_file():
                total += p.stat().st_size
    except OSError:
        pass
    return total / (1024 * 1024)


def log(verdict: str, mail_from: str, rcpt: str, size: int) -> None:
    ts = email.utils.formatdate()
    print(f"{ts} | {verdict} | from={mail_from} rcpt={rcpt} size={size}", file=sys.stderr, flush=True)


class MailstopHandler:
    def __init__(self, domain: str, users: set, root: Path, max_bytes: int,
                 max_disk_mb: int, greylist: "Greylist | None", dnsbl: str):
        self.domain = domain.lower()
        self.users = {u.lower() for u in users}
        self.catch_all = "*" in self.users
        self.root = root
        self.max_bytes = max_bytes
        self.max_disk_mb = max_disk_mb
        self.greylist = greylist
        self.dnsbl = dnsbl

    def _local_user(self, address: str):
        addr = address.strip("<>").lower()
        if "@" not in addr:
            return None
        user, _, dom = addr.partition("@")
        if dom != self.domain:
            return None
        if self.catch_all or user in self.users:
            return user
        return None

    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
        user = self._local_user(address)
        if user is None:
            log("reject-rcpt", envelope.mail_from or "?", address, 0)
            return "550 no such recipient"
        peer_ip = (session.peer or ("?",))[0]
        if self.dnsbl and dnsbl_listed(peer_ip, self.dnsbl):
            log("reject-dnsbl", envelope.mail_from or "?", address, 0)
            return "554 rejected (listed)"
        if self.greylist and not self.greylist.check(peer_ip, envelope.mail_from or "", address):
            log("greylist-450", envelope.mail_from or "?", address, 0)
            return "450 greylisted, please retry shortly"
        if dir_size_mb(self.root) > self.max_disk_mb:
            log("reject-disk-cap", envelope.mail_from or "?", address, 0)
            return "452 mailbox storage full"
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):
        size = len(envelope.content or b"")
        if size > self.max_bytes:
            log("reject-size", envelope.mail_from or "?", ",".join(envelope.rcpt_tos), size)
            return "552 message too large"
        for rcpt in envelope.rcpt_tos:
            user = self._local_user(rcpt)
            if user is None:
                continue
            new_dir = self.root / user / "new"
            tmp_dir = self.root / user / "tmp"
            for d in (new_dir, tmp_dir, self.root / user / "cur"):
                d.mkdir(parents=True, exist_ok=True)
            name = f"{int(time.time())}.M{os.getpid()}P{time.monotonic_ns()}.{socket.gethostname()}.eml"
            tmp_path = tmp_dir / name
            tmp_path.write_bytes(envelope.content)
            os.replace(tmp_path, new_dir / name)  # atomic per Maildir convention
            log("accept", envelope.mail_from or "?", rcpt, size)
        return "250 Message accepted for delivery"


def main() -> None:
    ap = argparse.ArgumentParser(description="receiving-only SMTP server; mail lands as local Maildir files")
    ap.add_argument("--domain", default=os.environ.get("MAILSTOP_DOMAIN"))
    ap.add_argument("--users", default=os.environ.get("MAILSTOP_USERS"))
    ap.add_argument("--root", default=os.environ.get("MAILSTOP_ROOT", "~/mail"))
    ap.add_argument("--max-mb", type=int, default=int(os.environ.get("MAILSTOP_MAX_MB", "25")))
    ap.add_argument("--max-disk-mb", type=int, default=int(os.environ.get("MAILSTOP_MAX_DISK_MB", "500")))
    ap.add_argument("--greylist", default=os.environ.get("MAILSTOP_GREYLIST", "on"))
    ap.add_argument("--dnsbl", default=os.environ.get("MAILSTOP_DNSBL", ""))
    ap.add_argument("--port", type=int, default=25)
    ap.add_argument("--bind", default="0.0.0.0")
    args = ap.parse_args()

    if not args.domain or not args.users:
        ap.error("--domain and --users are required (or MAILSTOP_DOMAIN / MAILSTOP_USERS)")

    root = Path(args.root).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    handler = MailstopHandler(
        domain=args.domain,
        users={u.strip() for u in args.users.split(",") if u.strip()},
        root=root,
        max_bytes=args.max_mb * 1024 * 1024,
        max_disk_mb=args.max_disk_mb,
        greylist=Greylist(root / ".greylist.json") if args.greylist != "off" else None,
        dnsbl=args.dnsbl.strip(),
    )
    controller = Controller(handler, hostname=args.bind, port=args.port)
    controller.start()
    print(f"mailstop: receiving for @{args.domain} on {args.bind}:{args.port}, storing under {root}", file=sys.stderr, flush=True)
    try:
        asyncio.new_event_loop().run_forever()
    except KeyboardInterrupt:
        controller.stop()


if __name__ == "__main__":
    main()
