'use strict';
/*
 * Digital Ballot – dependency-free Node server.
 *
 * Privacy design:
 *  - Only aggregate counters are stored (data/state.json). No per-vote record, no timestamps per vote,
 *    no IP, no user agent, no choice in any log.
 *  - The server writes NO access log. Hosting providers / proxies may still log technical data
 *    (e.g. IP addresses) outside this app – see README.
 *  - Abuse protection uses an in-memory table keyed by a salted hash of the IP. The salt is random per
 *    process start and never written to disk; the table is dropped on restart and entries expire.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PARTIES_FILE = path.join(__dirname, 'data', 'parties.json');
const CONFIG_FILE = path.join(__dirname, 'site-config.json');

const MIN_TICKET_AGE_MS = 2500;          // a human needs a moment to choose and confirm
const TICKET_TTL_MS = 30 * 60 * 1000;
const TICKETS_PER_IP_PER_HOUR = 10;      // soft limit: shared networks (offices, cellular NAT) exist
const VOTES_PER_IP_PER_HOUR = 5;
const SPECIAL = ['blank', 'undecided'];

const ipSalt = crypto.randomBytes(16);
const ticketSecret = crypto.randomBytes(32);
const usedNonces = new Map();            // nonce -> expiry
const ipHits = new Map();                // hash -> {tickets:[], votes:[], adminFails:[]}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const loadParties = () => readJson(PARTIES_FILE, { parties: [] }).parties;
const loadConfig = () => readJson(CONFIG_FILE, { brandName: 'הקלפי הדיגיטלי' });

let state = readJson(STATE_FILE, null) || { open: true, counts: {}, updatedAt: null };
function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
const validIds = () => new Set([...loadParties().map(p => p.id), ...SPECIAL]);

function clientKey(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY) ip = String(req.headers['x-forwarded-for'] || ip).split(',')[0].trim();
  return crypto.createHash('sha256').update(ipSalt).update(ip).digest('hex');
}
function hits(req) {
  const k = clientKey(req);
  if (!ipHits.has(k)) ipHits.set(k, { tickets: [], votes: [], adminFails: [] });
  return ipHits.get(k);
}
function prune(arr, windowMs) {
  const now = Date.now();
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return arr;
}
setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  for (const [k, h] of ipHits) {
    prune(h.tickets, 3600e3); prune(h.votes, 3600e3); prune(h.adminFails, 3600e3);
    if (!h.tickets.length && !h.votes.length && !h.adminFails.length) ipHits.delete(k);
  }
}, 60e3).unref();

function sign(payload) {
  return crypto.createHmac('sha256', ticketSecret).update(payload).digest('base64url');
}
function newTicket() {
  const nonce = crypto.randomBytes(12).toString('base64url');
  const issued = Date.now();
  const payload = `${nonce}.${issued}`;
  return `${payload}.${sign(payload)}`;
}
// Returns nonce if valid, otherwise a string error code.
function checkTicket(t) {
  if (typeof t !== 'string' || t.length > 200) return { err: 'invalid_ticket' };
  const parts = t.split('.');
  if (parts.length !== 3) return { err: 'invalid_ticket' };
  const [nonce, issuedStr, sig] = parts;
  const expected = sign(`${nonce}.${issuedStr}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { err: 'invalid_ticket' };
  const age = Date.now() - Number(issuedStr);
  if (!(age >= 0) || age > TICKET_TTL_MS) return { err: 'expired_ticket' };
  if (age < MIN_TICKET_AGE_MS) return { err: 'too_fast' };
  if (usedNonces.has(nonce)) return { err: 'used_ticket' };
  return { nonce };
}

function results() {
  const parties = loadParties();
  const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
  return {
    open: state.open,
    total,
    updatedAt: state.updatedAt,
    counts: Object.fromEntries([...parties.map(p => p.id), ...SPECIAL].map(id => [id, state.counts[id] || 0]))
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}
function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const h = String(req.headers['authorization'] || '');
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
function sameOrigin(req) {
  const o = req.headers['origin'];
  if (!o) return true;
  try { return new URL(o).host === req.headers['host']; } catch { return false; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()'
};

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('העמוד לא נמצא'); }
    res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

    for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'forbidden' });

    switch (route) {
      case 'GET /api/config':
        return send(res, 200, { config: loadConfig(), parties: loadParties(), open: state.open });
      case 'GET /api/results':
        return send(res, 200, results());

      case 'POST /api/ticket': {
        const h = hits(req);
        if (prune(h.tickets, 3600e3).length >= TICKETS_PER_IP_PER_HOUR) return send(res, 429, { error: 'rate_limited' });
        if (!state.open) return send(res, 403, { error: 'closed' });
        h.tickets.push(Date.now());
        return send(res, 200, { ticket: newTicket() });
      }

      case 'POST /api/vote': {
        const body = await readBody(req);
        const h = hits(req);
        if (prune(h.votes, 3600e3).length >= VOTES_PER_IP_PER_HOUR) return send(res, 429, { error: 'rate_limited' });
        if (!state.open) return send(res, 403, { error: 'closed' });
        if (typeof body.choice !== 'string' || !validIds().has(body.choice)) return send(res, 400, { error: 'invalid_choice' });
        const t = checkTicket(body.ticket);
        if (t.err) return send(res, t.err === 'too_fast' ? 429 : 400, { error: t.err });
        usedNonces.set(t.nonce, Date.now() + TICKET_TTL_MS * 2);
        h.votes.push(Date.now());
        state.counts[body.choice] = (state.counts[body.choice] || 0) + 1;
        // Only a coarse "last update" time is kept (rounded to the minute) so it cannot be matched to one voter.
        state.updatedAt = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
        saveState();
        return send(res, 200, { ok: true }); // never echo the choice back
      }

      case 'POST /api/admin/status':
      case 'POST /api/admin/reset': {
        const h = hits(req);
        if (prune(h.adminFails, 3600e3).length >= 10) return send(res, 429, { error: 'rate_limited' });
        if (!ADMIN_TOKEN) return send(res, 503, { error: 'admin_disabled' });
        if (!isAdmin(req)) { h.adminFails.push(Date.now()); return send(res, 401, { error: 'unauthorized' }); }
        const body = await readBody(req);
        if (url.pathname.endsWith('/status')) {
          if (typeof body.open !== 'boolean') return send(res, 400, { error: 'invalid_request' });
          state.open = body.open; saveState();
          return send(res, 200, { open: state.open });
        }
        if (body.confirm !== 'RESET') return send(res, 400, { error: 'confirmation_required' });
        state = { open: state.open, counts: {}, updatedAt: null }; usedNonces.clear(); saveState();
        return send(res, 200, { ok: true });
      }
      case 'POST /api/admin/check':
        if (!ADMIN_TOKEN) return send(res, 503, { error: 'admin_disabled' });
        return isAdmin(req) ? send(res, 200, { ok: true, open: state.open }) : (hits(req).adminFails.push(Date.now()), send(res, 401, { error: 'unauthorized' }));
      default:
        return send(res, 404, { error: 'not_found' });
    }
  } catch (e) {
    send(res, e.message === 'too_large' ? 413 : 400, { error: e.message === 'too_large' ? 'too_large' : 'bad_request' });
  }
});

server.listen(PORT, () => {
  console.log(`הקלפי הדיגיטלי רץ על פורט ${PORT}`);
  if (!ADMIN_TOKEN) console.log('אזהרה: ADMIN_TOKEN לא הוגדר – ממשק הניהול כבוי.');
});
