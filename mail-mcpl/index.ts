#!/usr/bin/env node
/**
 * mail-mcpl — MCPL server over a local Maildir (the mailstop pipe).
 *
 * mailstop (the companion tool) receives SMTP and writes mail as files;
 * this server gives an agent that mail as tools, without shell access:
 *
 *   mail_status — unread/read counts per mailbox user (no content)
 *   mail_list   — header metadata for messages (from/subject/date/size)
 *   mail_read   — one message: decoded headers + text body, attachments
 *                 listed by name/size only (never inlined); marks it read
 *                 (Maildir new/ -> cur/) unless keepUnread
 *
 * Push: watches new/ and delivers a push event when mail arrives, so the
 * agent is woken by a letter instead of polling. Wakes are gated by the
 * CONTACT BOOK (~/contacts.toml, MAILMCPL_CONTACTS): only senders with
 * wake=true wake the agent; everyone else accumulates silently and shows
 * up in mail_status / the next natural look. A wake costs the agent real
 * money; the contact book is the agent's own hand on that valve.
 *
 * Contact book (shared convention, not mail-specific): one TOML file that
 * answers "who am I in contact with, on which channels, and may they wake
 * me" — the agent-world analog of .env for secrets:
 *
 *   [alice]
 *   met = "2026-07-06, at the maker fair"
 *   notes = "runs the workshop next door"
 *   wake = true
 *   [alice.channels]
 *   email = "alice@example.org"
 *   discord = "discord:123456"
 *
 * Tools here: contacts_list / contacts_add / contacts_set_wake operate on
 * that file so instances without shell access still own their book.
 *
 * Sending is intentionally absent (the pipe is receiving-only today).
 *
 * Transports:
 *   --stdio                      classic child-process wiring
 *   --port N [--bind H]          WebSocket server (network MCPL); set
 *                                MAILMCPL_TOKEN to require a bearer token
 *                                (?token=... or Authorization header)
 *
 * Config (env): MAILMCPL_ROOT (default ~/mail), MAILMCPL_TOKEN,
 *               MAILMCPL_MAX_BODY (chars of body returned, default 20000)
 */
import { McplConnection } from '@connectome/mcpl-core';
import type {
  FeatureSetDeclaration, McplCapabilities, McplInitializeParams,
  McplInitializeResult, InitializeCapabilities, JsonRpcId,
} from '@connectome/mcpl-core';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const ROOT = (process.env.MAILMCPL_ROOT ?? join(homedir(), 'mail'));
const MAX_BODY = Number(process.env.MAILMCPL_MAX_BODY ?? 20000);
const CONTACTS_PATH = process.env.MAILMCPL_CONTACTS ?? join(homedir(), 'contacts.toml');
const FS_NAME = 'mail';

function log(...a: unknown[]): void { console.error('[mail-mcpl]', ...a); }

// ---------------------------------------------------------------------------
// Contact book (contacts.toml)
// ---------------------------------------------------------------------------

interface Contact {
  met?: string;
  notes?: string;
  wake?: boolean;
  channels?: Record<string, string>;
}

function loadContacts(): Record<string, Contact> {
  try {
    if (!existsSync(CONTACTS_PATH)) return {};
    return parseToml(readFileSync(CONTACTS_PATH, 'utf8')) as Record<string, Contact>;
  } catch (e) {
    log('contacts parse failed (treating as empty):', (e as Error).message);
    return {};
  }
}

function saveContacts(c: Record<string, Contact>): void {
  writeFileSync(CONTACTS_PATH, stringifyToml(c));
}

/** May this email sender wake the agent? Unknown senders never wake. */
function senderMayWake(fromHeader: string): { wake: boolean; who?: string } {
  const m = /<([^>]+)>/.exec(fromHeader);
  const addr = (m ? m[1] : fromHeader).trim().toLowerCase();
  const contacts = loadContacts();
  for (const [name, c] of Object.entries(contacts)) {
    if ((c.channels?.email ?? '').toLowerCase() === addr) {
      return { wake: c.wake === true, who: name };
    }
  }
  return { wake: false };
}

// ---------------------------------------------------------------------------
// Maildir access (read + new->cur move; nothing else touches the pipe's files)
// ---------------------------------------------------------------------------

function users(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'new')))
    .map((d) => d.name);
}

function listBox(user: string, box: 'new' | 'cur'): string[] {
  const dir = join(ROOT, user, box);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
}

/** Minimal RFC-2822 header parse + text-body extraction. Returns decoded
 *  headers of interest, the text/plain part (best effort), and attachment
 *  metadata. Never returns attachment content. */
function parseMessage(raw: Buffer): {
  headers: Record<string, string>;
  body: string;
  attachments: Array<{ filename: string; approxBytes: number }>;
} {
  const text = raw.toString('utf8');
  const sep = text.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const headEnd = text.indexOf(sep);
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const rest = headEnd >= 0 ? text.slice(headEnd + sep.length) : '';

  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (['from', 'to', 'cc', 'subject', 'date', 'message-id', 'reply-to'].includes(k)) {
        headers[k] = decodeMimeWords(line.slice(i + 1).trim());
      }
    }
  }

  const attachments: Array<{ filename: string; approxBytes: number }> = [];
  let body = rest;
  const ctype = /content-type:\s*multipart\/[^;]+;.*?boundary="?([^";\r\n]+)"?/is.exec(head);
  if (ctype) {
    const boundary = '--' + ctype[1];
    const parts = rest.split(boundary).slice(1, -1);
    body = '';
    for (const part of parts) {
      const pSep = part.indexOf(sep);
      const pHead = pSep >= 0 ? part.slice(0, pSep) : part;
      const pBody = pSep >= 0 ? part.slice(pSep + sep.length) : '';
      const fname = /filename="?([^";\r\n]+)"?/i.exec(pHead);
      if (fname) {
        attachments.push({ filename: fname[1], approxBytes: pBody.length });
      } else if (/content-type:\s*text\/plain/i.test(pHead) || (!/content-type:/i.test(pHead) && !body)) {
        body += decodeTransferEncoding(pBody, pHead);
      }
    }
    if (!body) body = '(no text/plain part; see attachments/parts list)';
  } else {
    body = decodeTransferEncoding(rest, head);
  }
  return { headers, body: body.trim(), attachments };
}

function decodeTransferEncoding(body: string, head: string): string {
  if (/content-transfer-encoding:\s*base64/i.test(head)) {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => {
        try { return Buffer.from(h, 'hex').toString('latin1'); } catch { return _; }
      });
  }
  return body;
}

/** Decode RFC-2047 encoded words in headers (=?utf-8?B?...?= / ?Q?...). */
function decodeMimeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      const buf = /b/i.test(enc)
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => Buffer.from(h, 'hex').toString('latin1')), 'latin1');
      return buf.toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
    } catch { return _; }
  });
}

function findMessage(id: string): { user: string; box: 'new' | 'cur'; path: string } | null {
  const name = basename(id); // defuse any path components in the id
  for (const user of users()) {
    for (const box of ['new', 'cur'] as const) {
      const p = join(ROOT, user, box, name);
      if (existsSync(p)) return { user, box, path: p };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCPL server
// ---------------------------------------------------------------------------

const featureSets: FeatureSetDeclaration[] = [{
  name: FS_NAME,
  description: 'Read mail delivered to this machine (Maildir): counts, headers, message bodies. Receiving-only.',
  uses: ['tools'],
  rollback: false,
  hostState: false,
}];

const toolDefinitions = [
  { name: 'mail_status', description: 'Mailbox overview: unread (new) and read (cur) counts per local user. No content.',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'mail_list',
    description: 'List messages: id, from, subject, date, size. Metadata only — bodies are fetched one at a time with mail_read.',
    inputSchema: { type: 'object' as const, properties: {
      user: { type: 'string', description: 'Mailbox user (default: the only/first user).' },
      box: { type: 'string', enum: ['new', 'cur', 'all'], description: 'new = unread (default), cur = read, all = both.' },
      limit: { type: 'number', description: 'Max messages to list (default 20, newest first).' },
    } } },
  { name: 'contacts_list', description: 'Show the contact book: who you are in touch with, their channels, and who may wake you.',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'contacts_add',
    description: 'Add or update a contact in the contact book (~/contacts.toml). Contacts with wake=true may wake you when their mail arrives; everyone else accumulates silently.',
    inputSchema: { type: 'object' as const, properties: {
      name: { type: 'string', description: 'Short handle for the contact (toml key).' },
      email: { type: 'string', description: 'Email address (optional).' },
      channel: { type: 'string', description: 'Other channel id, e.g. discord:... (optional).' },
      met: { type: 'string', description: 'Where/when you met (optional, free text).' },
      notes: { type: 'string', description: 'Your note about them (optional).' },
      wake: { type: 'boolean', description: 'May their mail wake you (default false).' },
    }, required: ['name'] } },
  { name: 'contacts_set_wake', description: 'Flip wake permission for an existing contact.',
    inputSchema: { type: 'object' as const, properties: {
      name: { type: 'string' }, wake: { type: 'boolean' },
    }, required: ['name', 'wake'] } },
  { name: 'mail_read',
    description: 'Read one message by id (from mail_list): decoded headers + text body (capped), attachments listed by name/size only, never inlined. Marks the message read (moves new -> cur) unless keepUnread=true.',
    inputSchema: { type: 'object' as const, properties: {
      id: { type: 'string', description: 'Message id (the filename from mail_list).' },
      keepUnread: { type: 'boolean', description: 'Do not move the message out of new/ (default false).' },
    }, required: ['id'] } },
];

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown; }

class MailServer {
  private conn: McplConnection | null = null;
  private watchers: Array<ReturnType<typeof watch>> = [];
  private pushDebounce: ReturnType<typeof setTimeout> | null = null;
  private mcplEnabled = false;

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.init();
    this.watchNew();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') this.handle(msg.request as ReqMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') log('connection error:', e);
    }
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.pushDebounce) clearTimeout(this.pushDebounce);
    this.conn = null;
  }

  private async init(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: McplCapabilities = { version: '0.4', pushEvents: true, channels: false, rollback: false, featureSets };
    const capabilities: InitializeCapabilities = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult = { protocolVersion: '2024-11-05', capabilities, serverInfo: { name: 'mail-mcpl', version: '0.1.0' } };
    conn.sendResponse(msg.request.id, result);
    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      log(`initialized (${this.mcplEnabled ? 'MCPL' : 'MCP'} mode), root=${ROOT}, users=[${users().join(', ')}]`);
    }
  }

  /** Wake the agent when mail lands: watch each user's new/ directory. */
  private watchNew(): void {
    for (const user of users()) {
      try {
        const w = watch(join(ROOT, user, 'new'), (event, filename) => {
          if (event !== 'rename' || !filename || filename.startsWith('.')) return;
          if (!existsSync(join(ROOT, user, 'new', filename))) return; // removal, not arrival
          // debounce bursts into one push
          if (this.pushDebounce) clearTimeout(this.pushDebounce);
          this.pushDebounce = setTimeout(() => this.pushNewMail(), 1500);
        });
        this.watchers.push(w);
      } catch (e) {
        log(`watch failed for ${user}:`, (e as Error).message);
      }
    }
  }

  private announced = new Set<string>();

  private pushNewMail(): void {
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) return;
    // Look at not-yet-announced messages; wake ONLY if a wake=true contact
    // wrote. Everyone else accumulates silently (a wake costs the agent
    // real money; the contact book is the agent's valve).
    const wakeLines: string[] = [];
    let silent = 0;
    for (const u of users()) {
      for (const f of listBox(u, 'new')) {
        const key = `${u}/${f}`;
        if (this.announced.has(key)) continue;
        this.announced.add(key);
        try {
          const { headers } = parseMessage(readFileSync(join(ROOT, u, 'new', f)));
          const verdict = senderMayWake(headers.from ?? '');
          if (verdict.wake) {
            wakeLines.push(`${u}@: from ${verdict.who} (${headers.from}) — "${headers.subject ?? '(no subject)'}"`);
          } else {
            silent++;
          }
        } catch { silent++; }
      }
    }
    if (wakeLines.length === 0) {
      if (silent > 0) log(`${silent} new message(s) accumulated silently (no wake-listed sender)`);
      return;
    }
    const tail = silent > 0 ? ` (+${silent} more from senders not on your wake list)` : '';
    try {
      conn.sendNotification('mcpl/pushEvent', {
        featureSet: FS_NAME,
        event: { type: 'text', text: `[mail] ${wakeLines.join('; ')}${tail}. Use mail_list / mail_read.` },
      });
    } catch (e) { log('push failed:', (e as Error).message); }
  }

  private text(t: string, isError?: boolean) {
    return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) };
  }

  private handle(req: ReqMsg): void {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': conn.sendResponse(req.id, { tools: toolDefinitions }); break;
        case 'tools/call': conn.sendResponse(req.id, this.call(params.name as string, (params.arguments ?? {}) as Record<string, unknown>)); break;
        default: conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      conn.sendError(req.id, -32000, (e as Error).message);
    }
  }

  private call(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'mail_status': {
        const rows = users().map((u) => `${u}@ — unread: ${listBox(u, 'new').length}, read: ${listBox(u, 'cur').length}`);
        return this.text(rows.length ? rows.join('\n') : `(no mailboxes under ${ROOT})`);
      }
      case 'mail_list': {
        const all = users();
        const user = (args.user as string) ?? all[0];
        if (!user || !all.includes(user)) return this.text(`unknown user; have: ${all.join(', ') || '(none)'}`, true);
        const boxes: Array<'new' | 'cur'> = args.box === 'cur' ? ['cur'] : args.box === 'all' ? ['new', 'cur'] : ['new'];
        const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
        const rows: string[] = [];
        for (const box of boxes) {
          for (const f of listBox(user, box).reverse().slice(0, limit)) {
            const p = join(ROOT, user, box, f);
            try {
              const { headers } = parseMessage(readFileSync(p));
              const size = statSync(p).size;
              rows.push(`[${box}] ${f}\n  from: ${headers.from ?? '?'} | date: ${headers.date ?? '?'} | ${size}b\n  subject: ${headers.subject ?? '(none)'}`);
            } catch { rows.push(`[${box}] ${f} (unparseable)`); }
            if (rows.length >= limit) break;
          }
        }
        return this.text(rows.length ? rows.join('\n') : `no messages in ${boxes.join('+')} for ${user}@`);
      }
      case 'contacts_list': {
        const c = loadContacts();
        const names = Object.keys(c);
        if (!names.length) return this.text(`(contact book empty or missing at ${CONTACTS_PATH})`);
        const rows = names.map((n) => {
          const ch = Object.entries(c[n].channels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
          return `${n}${c[n].wake ? ' [wake]' : ''} — ${ch || '(no channels)'}${c[n].met ? ` | met: ${c[n].met}` : ''}${c[n].notes ? ` | ${c[n].notes}` : ''}`;
        });
        return this.text(rows.join('\n'));
      }
      case 'contacts_add': {
        const name = String(args.name ?? '').trim();
        if (!name) return this.text('name is required', true);
        const c = loadContacts();
        const entry: Contact = c[name] ?? {};
        if (args.met !== undefined) entry.met = String(args.met);
        if (args.notes !== undefined) entry.notes = String(args.notes);
        if (args.wake !== undefined) entry.wake = args.wake === true;
        entry.channels = entry.channels ?? {};
        if (args.email !== undefined) entry.channels.email = String(args.email);
        if (args.channel !== undefined) {
          const v = String(args.channel);
          const k = v.includes(':') ? v.split(':')[0] : 'other';
          entry.channels[k] = v;
        }
        c[name] = entry;
        saveContacts(c);
        return this.text(`saved: ${name}${entry.wake ? ' [wake]' : ''} (${Object.entries(entry.channels).map(([k, v]) => `${k}=${v}`).join(', ') || 'no channels'})`);
      }
      case 'contacts_set_wake': {
        const c = loadContacts();
        const name = String(args.name ?? '');
        if (!c[name]) return this.text(`no such contact: ${name}`, true);
        c[name].wake = args.wake === true;
        saveContacts(c);
        return this.text(`${name}: wake=${c[name].wake}`);
      }
      case 'mail_read': {
        const id = String(args.id ?? '');
        const loc = findMessage(id);
        if (!loc) return this.text(`message not found: ${id}`, true);
        const { headers, body, attachments } = parseMessage(readFileSync(loc.path));
        if (loc.box === 'new' && args.keepUnread !== true) {
          try { renameSync(loc.path, join(ROOT, loc.user, 'cur', basename(loc.path))); } catch (e) { log('new->cur move failed:', (e as Error).message); }
        }
        const h = ['from', 'to', 'cc', 'reply-to', 'date', 'subject'].filter((k) => headers[k]).map((k) => `${k}: ${headers[k]}`).join('\n');
        const att = attachments.length ? `\n\nattachments (names only, not inlined):\n${attachments.map((a) => `  - ${a.filename} (~${a.approxBytes}b)`).join('\n')}` : '';
        const capped = body.length > MAX_BODY ? body.slice(0, MAX_BODY) + `\n…[truncated at ${MAX_BODY} chars of ${body.length}]` : body;
        return this.text(`${h}\n\n${capped}${att}`);
      }
      default:
        return this.text(`unknown tool: ${name}`, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const portIdx = argv.indexOf('--port');
  if (argv.includes('--stdio')) {
    const conn = McplConnection.fromStreams(process.stdin, process.stdout);
    await new MailServer().serve(conn);
    return;
  }
  if (portIdx >= 0) {
    const port = Number(argv[portIdx + 1]);
    const bindIdx = argv.indexOf('--bind');
    const bind = bindIdx >= 0 ? argv[bindIdx + 1] : '127.0.0.1';
    const token = process.env.MAILMCPL_TOKEN;
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ host: bind, port });
    wss.on('connection', (ws, req) => {
      if (token) {
        const url = new URL(req.url ?? '/', 'http://x');
        const auth = req.headers.authorization ?? '';
        const ok = url.searchParams.get('token') === token || auth === `Bearer ${token}`;
        if (!ok) { log('rejected connection (bad token)'); ws.close(4401, 'unauthorized'); return; }
      }
      log('client connected');
      const conn = McplConnection.fromWebSocket(ws as never);
      void new MailServer().serve(conn).then(() => log('client disconnected'));
    });
    log(`mail-mcpl (WebSocket) on ${bind}:${port}${token ? ' with token auth' : ' WITHOUT auth (loopback only!)'}`);
    return;
  }
  console.error('usage: mail-mcpl --stdio | --port N [--bind H]   (env: MAILMCPL_ROOT, MAILMCPL_TOKEN, MAILMCPL_MAX_BODY)');
  process.exit(2);
}

void main();
