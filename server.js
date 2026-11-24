'use strict';
/*
  Fixboard server. No outside packages: Node 22.13 or newer is all it needs.
  Members-only: nothing except the sign-in page, legal pages and the public notice is readable without a verified account.
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dbmod = require('./db');
const mail = require('./mail');

const PROD = process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SECRET = process.env.SESSION_SECRET || (PROD ? '' : 'dev-secret-change-me');
const FOUNDER_EMAIL = (process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
const FOUNDER_NAME = process.env.FOUNDER_NAME || 'Nishant Parekh';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || FOUNDER_EMAIL || 'support@example.com';
const EXPOSE_CODE = !PROD && process.env.DEV_EXPOSE_CODE === '1';
const SESSION_DAYS = 14;
const STAFF_IDLE_MS = 30 * 60 * 1000;

if (PROD) {
  const missing = ['SESSION_SECRET', 'FOUNDER_EMAIL', 'MAIL_PROVIDER', 'MAIL_API_KEY', 'MAIL_FROM'].filter(k => !process.env[k]);
  if (missing.length) { console.error('Missing required settings for production: ' + missing.join(', ')); process.exit(1); }
  if (!/^https:\/\//.test(BASE_URL)) { console.error('BASE_URL must start with https:// in production.'); process.exit(1); }
}

const db = dbmod.open(DATA_DIR);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------- constants ---------- */
const SKILLS = ['Inventory', 'Forecasting', 'Transportation', 'Warehouse ops', 'Procurement', 'SAP', 'Power BI', 'SQL', 'Excel', 'Optimization', 'Master data', 'Cold chain'];
const LEAGUE_NAMES = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const REASONS = ['Spam or off-topic', 'Shares confidential information', 'Copied from another source', 'Abusive or unprofessional', 'Fake identity or organization', 'Other'];
const CATS = ['Account or sign-in', 'Verification', 'Something is broken', 'Safety or conduct', 'Idea or request'];
const DEFAULTS = {
  leagues: { silver: 10, gold: 25, platinum: 50 },
  flags: { ratings: true, leagues: true, intros: true },
  blocked: ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'live.com', 'msn.com'],
  approved: [],
  announcement: null
};

/* ---------- small helpers ---------- */
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }
const bad = m => new HttpError(400, m);
const now = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function safeEq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function normEmail(e) { e = String(e || '').trim().toLowerCase(); return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null; }
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (s, max) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim().slice(0, max);
function setting(k) { const r = db.get('SELECT value FROM settings WHERE key=?', k); return r ? JSON.parse(r.value) : DEFAULTS[k]; }
function setSetting(k, v) { db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v)); }
function audit(user, text) { db.run('INSERT INTO audit(at,who,text) VALUES(?,?,?)', now(), user ? user.name + ' (' + user.staff_role + ')' : 'System', text); }
async function notify(to, subject, text) { try { await mail.send({ to, subject, text: text + '\n\nFixboard · ' + BASE_URL }); } catch (e) { console.error('[mail] failed:', e.message); } }

/* simple in-memory rate limiter (resets when the server restarts) */
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(t); hits.set(key, arr); return false;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) { if (!v.length || t - v[v.length - 1] > 3600e3) hits.delete(k); } }, 600e3).unref();
function throttle(key, max, windowMs, msg) { if (limited(key, max, windowMs)) throw new HttpError(429, msg || 'Too many requests. Please wait a bit and try again.'); }

/* ---------- people, points, leagues ---------- */
const pub = u => ({ id: u.id, email: u.email, name: u.name, kind: u.kind, org: u.org, title: u.title, skills: JSON.parse(u.skills || '[]'), status: u.status, staffRole: u.staff_role || null });
function pointsMap() {
  const m = new Map();
  const base = `FROM solutions s JOIN problems p ON p.id=s.problem_id JOIN users u ON u.id=s.user_id WHERE s.hidden=0 AND p.hidden=0 AND u.status='active'`;
  for (const r of db.all(`SELECT s.user_id uid, SUM(r.stars) st FROM ratings r JOIN solutions s ON s.id=r.solution_id JOIN problems p ON p.id=s.problem_id JOIN users u ON u.id=s.user_id WHERE s.hidden=0 AND p.hidden=0 AND u.status='active' GROUP BY s.user_id`)) m.set(r.uid, r.st);
  for (const r of db.all(`SELECT s.user_id uid, COUNT(*) c ${base} AND s.accepted=1 GROUP BY s.user_id`)) m.set(r.uid, (m.get(r.uid) || 0) + 10 * r.c);
  return m;
}
function leagueOf(points, t) {
  const th = [0, t.silver, t.gold, t.platinum];
  let idx = 0; th.forEach((v, i) => { if (points >= v) idx = i; });
  return { idx, name: LEAGUE_NAMES[idx], points, floor: th[idx], next: idx < 3 ? LEAGUE_NAMES[idx + 1] : null, need: idx < 3 ? th[idx + 1] : null };
}
function authorOf(row, prefix, pm, th) {
  const id = row[prefix + 'id'];
  return { id, name: row[prefix + 'name'], kind: row[prefix + 'kind'], org: row[prefix + 'org'], title: row[prefix + 'title'], league: leagueOf(pm.get(id) || 0, th) };
}

/* ---------- sessions ---------- */
function parseCookies(h) { const o = {}; String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function cookie(name, value, maxAgeSec) { return name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec + (PROD ? '; Secure' : ''); }
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url'), t = Date.now();
  db.run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen) VALUES(?,?,?,?,?)', sha(token), userId, now(), new Date(t + SESSION_DAYS * 864e5).toISOString(), now());
  res.setHeader('Set-Cookie', cookie('fb_session', token, SESSION_DAYS * 86400));
}
function currentUser(req) {
  const tok = parseCookies(req.headers.cookie).fb_session;
  if (!tok) return null;
  const h = sha(tok);
  const u = db.get('SELECT u.*, s.last_seen AS seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', h, now());
  if (!u) return null;
  const idle = Date.now() - Date.parse(u.seen);
  if (u.staff_role && idle > STAFF_IDLE_MS) { db.run('DELETE FROM sessions WHERE token_hash=?', h); return null; }
  if (idle > 60e3) db.run('UPDATE sessions SET last_seen=? WHERE token_hash=?', now(), h);
  u.token_hash = h;
  return u;
}

/* ---------- router ---------- */
const routes = [];
function route(method, p, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + p.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, fn });
}
const member = { auth: 'member' };
const staff = roles => ({ auth: 'staff', roles });

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 100e3) { reject(new HttpError(413, 'That request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); } catch (e) { reject(bad('The request was not valid JSON.')); } });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'index.html', '/terms': 'terms.html', '/privacy': 'privacy.html', '/rules': 'rules.html' };
function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found');
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  try {
    const r = routes.filter(x => x.method === req.method).map(x => ({ x, m: x.re.exec(url.pathname) })).find(o => o.m);
    if (!r) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET') {
      if (req.headers['x-requested-with'] !== 'fixboard') throw new HttpError(403, 'Request blocked.');
      const origin = req.headers.origin;
      if (origin) { let h; try { h = new URL(origin).host; } catch (e) { h = ''; } if (h !== req.headers.host) throw new HttpError(403, 'Request blocked.'); }
    }
    const ctx = { req, res, url, params: {}, body: {}, user: currentUser(req), ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() };
    r.x.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(r.m[i + 1]); });
    if (req.method !== 'GET') ctx.body = await readBody(req);
    const a = r.x.opts.auth;
    if (a === 'member' || a === 'staff') {
      if (!ctx.user) throw new HttpError(401, 'Please sign in.');
      if (ctx.user.status !== 'active') throw new HttpError(403, 'Your account is not active.', { status: ctx.user.status });
      if (a === 'staff' && (!ctx.user.staff_role || (r.x.opts.roles && !r.x.opts.roles.includes(ctx.user.staff_role)))) throw new HttpError(403, 'Your role cannot do this.');
    }
    const out = await r.x.fn(ctx);
    send(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, Object.assign({ error: e.message }, e.extra));
    console.error('[error]', req.method, req.url, e);
    send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  }
}

/* ---------- public ---------- */
const publicInfo = () => ({ announcement: setting('announcement'), flags: setting('flags'), founder: FOUNDER_NAME, support: SUPPORT_EMAIL, skills: SKILLS, reasons: REASONS, cats: CATS });
route('GET', '/api/public', () => publicInfo());

/* ---------- sign-in ---------- */
function domainRule(kind, d) {
  const edu = /\.edu$/.test(d);
  if (setting('blocked').includes(d)) return { error: kind === 'student' ? 'Use your school email address, not a personal one.' : 'Personal email addresses are not accepted. Use your company email.' };
  if (kind === 'student') return { review: edu ? null : 'School email does not end in .edu' };
  if (edu) return { error: 'Industry members sign up with a work email. Choose Student to use a .edu address.' };
  return { review: setting('approved').includes(d) ? null : 'Company domain is not on the approved list' };
}
route('POST', '/api/auth/start', async ctx => {
  const b = ctx.body, email = normEmail(b.email);
  if (!email) throw bad('Enter a full email address.');
  throttle('start-ip:' + ctx.ip, 30, 3600e3);
  throttle('start-em:' + email, 5, 3600e3, 'Too many codes requested for this email. Try again in an hour.');
  const d = email.split('@')[1];
  let user = db.get('SELECT * FROM users WHERE email=?', email);
  const invite = db.get('SELECT * FROM invites WHERE email=?', email);
  const isFounder = !!FOUNDER_EMAIL && email === FOUNDER_EMAIL;
  if (!user && !isFounder && !invite) {
    if (!b.kind) return { ok: true, needsProfile: true };
    if (!['student', 'industry'].includes(b.kind)) throw bad('Choose student or industry.');
    const name = clean(b.name, 80), org = clean(b.org, 120), title = clean(b.title, 120);
    if (name.length < 2) throw bad('Enter your full name.');
    if (org.length < 2) throw bad(b.kind === 'student' ? 'Enter your school.' : 'Enter your company.');
    const rule = domainRule(b.kind, d);
    if (rule.error) throw bad(rule.error);
    db.run('INSERT INTO users(email,name,kind,org,title,status,review_reason,created_at) VALUES(?,?,?,?,?,?,?,?)', email, name, b.kind, org, title, 'unverified', rule.review, now());
  } else if (!user && invite && !clean(b.name, 80)) {
    return { ok: true, needsProfile: true, staffInvite: true };
  } else if (!user && invite) {
    const name = clean(b.name, 80); if (name.length < 2) throw bad('Enter your full name.');
    db.run('INSERT INTO users(email,name,kind,org,title,status,staff_role,created_at) VALUES(?,?,?,?,?,?,?,?)', email, name, 'industry', 'Fixboard team', 'Staff', 'unverified', invite.role, now());
  } else if (!user && isFounder) {
    db.run('INSERT INTO users(email,name,kind,org,title,status,staff_role,created_at) VALUES(?,?,?,?,?,?,?,?)', email, FOUNDER_NAME, 'industry', 'Fixboard', 'Founder', 'unverified', 'owner', now());
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.run('INSERT INTO codes(email,code_hash,expires_at,attempts) VALUES(?,?,?,0) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0',
    email, hmac(email + ':' + code), new Date(Date.now() + 10 * 60e3).toISOString());
  await notify(email, 'Your Fixboard sign-in code', 'Your code is ' + code + '. It expires in 10 minutes.\n\nIf you did not ask for this, you can ignore this email.');
  return EXPOSE_CODE ? { ok: true, devCode: code } : { ok: true };
});
route('POST', '/api/auth/verify', ctx => {
  const email = normEmail(ctx.body.email), code = String(ctx.body.code || '').trim();
  if (!email || !/^\d{6}$/.test(code)) throw bad('Enter the 6-digit code from your email.');
  throttle('verify-ip:' + ctx.ip, 40, 3600e3);
  const row = db.get('SELECT * FROM codes WHERE email=?', email);
  if (!row || row.expires_at < now()) throw bad('That code has expired. Ask for a new one.');
  if (row.attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
  if (!safeEq(row.code_hash, hmac(email + ':' + code))) {
    db.run('UPDATE codes SET attempts=attempts+1 WHERE email=?', email);
    throw bad('That code does not match. Check the email and try again.');
  }
  db.run('DELETE FROM codes WHERE email=?', email);
  let u = db.get('SELECT * FROM users WHERE email=?', email);
  if (!u) throw bad('No account found for this email.');
  if (FOUNDER_EMAIL && email === FOUNDER_EMAIL && u.staff_role !== 'owner') { db.run("UPDATE users SET staff_role='owner' WHERE id=?", u.id); }
  if (u.status === 'unverified') {
    const status = u.review_reason ? 'pending_review' : 'active';
    db.run('UPDATE users SET status=? WHERE id=?', status, u.id);
    db.run('DELETE FROM invites WHERE email=?', email);
  }
  db.run('UPDATE users SET last_login=? WHERE id=?', now(), u.id);
  u = db.get('SELECT * FROM users WHERE id=?', u.id);
  startSession(ctx.res, u.id);
  return { ok: true, status: u.status };
});
route('POST', '/api/auth/logout', ctx => {
  if (ctx.user) db.run('DELETE FROM sessions WHERE token_hash=?', ctx.user.token_hash);
  ctx.res.setHeader('Set-Cookie', cookie('fb_session', '', 0));
});
route('GET', '/api/me', ctx => {
  const info = publicInfo();
  if (!ctx.user) return Object.assign({ user: null }, info);
  const pm = pointsMap(), th = setting('leagues');
  return Object.assign({ user: pub(ctx.user), league: leagueOf(pm.get(ctx.user.id) || 0, th), thresholds: th }, info);
});
route('PUT', '/api/me/profile', member, ctx => {
  const skills = (Array.isArray(ctx.body.skills) ? ctx.body.skills : []).filter(s => SKILLS.includes(s));
  db.run('UPDATE users SET skills=?, title=? WHERE id=?', JSON.stringify([...new Set(skills)]), clean(ctx.body.title == null ? ctx.user.title : ctx.body.title, 120), ctx.user.id);
});

/* ---------- board ---------- */
route('GET', '/api/board', member, ctx => {
  const pm = pointsMap(), th = setting('leagues');
  const A = 'u.id AS a_id, u.name AS a_name, u.kind AS a_kind, u.org AS a_org, u.title AS a_title';
  const probs = db.all(`SELECT p.*, ${A} FROM problems p JOIN users u ON u.id=p.user_id WHERE p.hidden=0 AND u.status='active' ORDER BY p.id DESC LIMIT 300`);
  const sols = db.all(`SELECT s.*, ${A} FROM solutions s JOIN users u ON u.id=s.user_id WHERE s.hidden=0 AND u.status='active' ORDER BY s.id ASC`);
  const rat = db.all('SELECT solution_id, user_id, stars FROM ratings');
  const bySol = new Map();
  rat.forEach(r => { const o = bySol.get(r.solution_id) || { sum: 0, n: 0, mine: 0 }; o.sum += r.stars; o.n++; if (r.user_id === ctx.user.id) o.mine = r.stars; bySol.set(r.solution_id, o); });
  const solsBy = new Map();
  sols.forEach(s => {
    const o = bySol.get(s.id) || { sum: 0, n: 0, mine: 0 };
    const item = { id: s.id, body: s.body, accepted: !!s.accepted, created: s.created_at, author: authorOf(s, 'a_', pm, th), count: o.n, avg: o.n ? o.sum / o.n : null, mine: o.mine, own: s.user_id === ctx.user.id };
    (solsBy.get(s.problem_id) || solsBy.set(s.problem_id, []).get(s.problem_id)).push(item);
  });
  return {
    problems: probs.map(p => ({ id: p.id, title: p.title, body: p.body, tags: JSON.parse(p.tags), status: p.status, created: p.created_at, author: authorOf(p, 'a_', pm, th), own: p.user_id === ctx.user.id, solutions: solsBy.get(p.id) || [] }))
  };
});
route('POST', '/api/problems', member, ctx => {
  if (ctx.user.kind !== 'industry') throw new HttpError(403, 'Only verified industry members can post problems.');
  throttle('post:' + ctx.user.id, 10, 3600e3, 'You have posted several problems in the last hour. Please wait a little.');
  const title = clean(ctx.body.title, 140), body = cleanText(ctx.body.body, 6000);
  if (title.length < 8) throw bad('Add a title of at least a few words.');
  if (body.length < 30) throw bad('Add a few sentences of detail so people can help.');
  const tags = [...new Set((Array.isArray(ctx.body.tags) ? ctx.body.tags : []).filter(t => SKILLS.includes(t)))];
  const r = db.run('INSERT INTO problems(user_id,title,body,tags,created_at) VALUES(?,?,?,?,?)', ctx.user.id, title, body, JSON.stringify(tags), now());
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/problems/:id/solutions', member, ctx => {
  throttle('sol:' + ctx.user.id, 30, 3600e3);
  const p = db.get('SELECT id FROM problems WHERE id=? AND hidden=0', ctx.params.id);
  if (!p) throw new HttpError(404, 'That problem is no longer available.');
  const body = cleanText(ctx.body.body, 6000);
  if (body.length < 20) throw bad('Write at least a couple of sentences so the poster can use it.');
  const r = db.run('INSERT INTO solutions(problem_id,user_id,body,created_at) VALUES(?,?,?,?)', p.id, ctx.user.id, body, now());
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/solutions/:id/rating', member, ctx => {
  if (!setting('flags').ratings) throw new HttpError(403, 'Ratings are paused right now.');
  const s = db.get(`SELECT s.*, u.org AS a_org, u.email AS a_email, u.name AS a_name FROM solutions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.hidden=0`, ctx.params.id);
  if (!s) throw new HttpError(404, 'That solution is no longer available.');
  if (s.user_id === ctx.user.id) throw new HttpError(403, "You can't rate your own solution.");
  const sameOrg = s.a_org.trim().toLowerCase() === ctx.user.org.trim().toLowerCase() || s.a_email.split('@')[1] === ctx.user.email.split('@')[1];
  if (sameOrg) throw new HttpError(403, "Members from the same organization can't rate each other.");
  const stars = parseInt(ctx.body.stars, 10);
  if (!(stars >= 0 && stars <= 5)) throw bad('Choose 1 to 5 stars.');
  const th = setting('leagues'), before = leagueOf(pointsMap().get(s.user_id) || 0, th);
  if (stars === 0) db.run('DELETE FROM ratings WHERE solution_id=? AND user_id=?', s.id, ctx.user.id);
  else db.run('INSERT INTO ratings(solution_id,user_id,stars,created_at) VALUES(?,?,?,?) ON CONFLICT(solution_id,user_id) DO UPDATE SET stars=excluded.stars', s.id, ctx.user.id, stars, now());
  const after = leagueOf(pointsMap().get(s.user_id) || 0, th);
  return { authorName: s.a_name, movedUp: after.idx > before.idx ? after.name : null };
});
route('POST', '/api/solutions/:id/accept', member, ctx => {
  const s = db.get('SELECT s.*, p.user_id AS owner FROM solutions s JOIN problems p ON p.id=s.problem_id WHERE s.id=? AND s.hidden=0', ctx.params.id);
  if (!s) throw new HttpError(404, 'That solution is no longer available.');
  if (s.owner !== ctx.user.id) throw new HttpError(403, 'Only the person who posted the problem can accept a solution.');
  if (db.get('SELECT 1 AS x FROM solutions WHERE problem_id=? AND accepted=1', s.problem_id)) throw bad('This problem already has an accepted solution.');
  const th = setting('leagues'), before = leagueOf(pointsMap().get(s.user_id) || 0, th);
  db.tx(() => { db.run('UPDATE solutions SET accepted=1 WHERE id=?', s.id); db.run("UPDATE problems SET status='solved' WHERE id=?", s.problem_id); });
  const after = leagueOf(pointsMap().get(s.user_id) || 0, th);
  return { movedUp: after.idx > before.idx ? after.name : null };
});
route('POST', '/api/reports', member, ctx => {
  throttle('report:' + ctx.user.id, 20, 3600e3);
  const type = ctx.body.type, ref = parseInt(ctx.body.ref, 10);
  if (!['problem', 'solution'].includes(type) || !ref) throw bad('Choose what to report.');
  const exists = type === 'problem' ? db.get('SELECT id FROM problems WHERE id=?', ref) : db.get('SELECT id FROM solutions WHERE id=?', ref);
  if (!exists) throw new HttpError(404, 'That content is no longer available.');
  const reason = REASONS.includes(ctx.body.reason) ? ctx.body.reason : 'Other';
  db.run('INSERT INTO reports(type,ref,reporter_id,reason,note,created_at) VALUES(?,?,?,?,?,?)', type, ref, ctx.user.id, reason, cleanText(ctx.body.note, 1000), now());
});

/* ---------- people, intros, leagues ---------- */
route('GET', '/api/people', member, ctx => {
  const pm = pointsMap(), th = setting('leagues');
  const rows = db.all("SELECT * FROM users WHERE status='active' AND id<>? ORDER BY name", ctx.user.id);
  const sent = new Map(db.all('SELECT to_id, status FROM intros WHERE from_id=?', ctx.user.id).map(r => [r.to_id, r.status]));
  return { people: rows.map(u => ({ id: u.id, name: u.name, kind: u.kind, org: u.org, title: u.title, skills: JSON.parse(u.skills), league: leagueOf(pm.get(u.id) || 0, th), intro: sent.get(u.id) || null })) };
});
route('GET', '/api/leagues', member, ctx => {
  const pm = pointsMap(), th = setting('leagues');
  const rows = db.all("SELECT id,name,kind,org FROM users WHERE status='active'");
  return { thresholds: th, me: ctx.user.id, members: rows.map(u => ({ id: u.id, name: u.name, kind: u.kind, org: u.org, points: pm.get(u.id) || 0, league: leagueOf(pm.get(u.id) || 0, th) })).sort((a, b) => b.points - a.points) };
});
route('GET', '/api/intros', member, ctx => {
  const inc = db.all(`SELECT i.id, i.status, u.name, u.kind, u.org, u.title, u.email FROM intros i JOIN users u ON u.id=i.from_id WHERE i.to_id=? AND u.status='active' ORDER BY i.id DESC`, ctx.user.id);
  const out = db.all(`SELECT i.id, i.status, u.name, u.kind, u.org, u.title, u.email FROM intros i JOIN users u ON u.id=i.to_id WHERE i.from_id=? AND u.status='active' ORDER BY i.id DESC`, ctx.user.id);
  const hide = r => ({ id: r.id, status: r.status, name: r.name, kind: r.kind, org: r.org, title: r.title, email: r.status === 'accepted' ? r.email : null });
  return { incoming: inc.map(hide), outgoing: out.map(hide) };
});
route('POST', '/api/intros', member, async ctx => {
  if (!setting('flags').intros) throw new HttpError(403, 'Intro requests are paused right now.');
  throttle('intro:' + ctx.user.id, 15, 24 * 3600e3, 'You have sent many intro requests today. Try again tomorrow.');
  const to = db.get("SELECT * FROM users WHERE id=? AND status='active'", parseInt(ctx.body.to, 10));
  if (!to || to.id === ctx.user.id) throw bad('Choose another member.');
  try { db.run('INSERT INTO intros(from_id,to_id,created_at) VALUES(?,?,?)', ctx.user.id, to.id, now()); } catch (e) { throw bad('You already sent an intro request to this member.'); }
  await notify(to.email, 'A Fixboard member would like to connect', ctx.user.name + ' (' + ctx.user.title + ', ' + ctx.user.org + ') asked for an intro. Sign in to accept or decline. Your email is only shared if you accept.');
});
route('POST', '/api/intros/:id', member, ctx => {
  const i = db.get('SELECT * FROM intros WHERE id=? AND to_id=?', ctx.params.id, ctx.user.id);
  if (!i) throw new HttpError(404, 'Request not found.');
  const d = ctx.body.decision;
  if (!['accepted', 'declined'].includes(d)) throw bad('Choose accept or decline.');
  db.run('UPDATE intros SET status=? WHERE id=?', d, i.id);
});

/* ---------- member help ---------- */
route('GET', '/api/tickets', member, ctx => {
  const ts = db.all('SELECT * FROM tickets WHERE user_id=? ORDER BY id DESC', ctx.user.id);
  const rep = db.all('SELECT r.* FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id WHERE t.user_id=? ORDER BY r.id', ctx.user.id);
  return { tickets: ts.map(t => ({ id: t.id, cat: t.cat, subject: t.subject, body: t.body, status: t.status, created: t.created_at, replies: rep.filter(r => r.ticket_id === t.id).map(r => ({ who: r.who, body: r.body, created: r.created_at })) })) };
});
route('POST', '/api/tickets', member, ctx => {
  throttle('ticket:' + ctx.user.id, 10, 3600e3);
  const subject = clean(ctx.body.subject, 140), body = cleanText(ctx.body.body, 3000);
  if (!subject || body.length < 10) throw bad('Add a subject and a few words about what happened.');
  db.run('INSERT INTO tickets(user_id,cat,subject,body,created_at) VALUES(?,?,?,?,?)', ctx.user.id, CATS.includes(ctx.body.cat) ? ctx.body.cat : CATS[0], subject, body, now());
});

/* ---------- staff console ---------- */
const ALL = ['owner', 'admin', 'moderator', 'support'], MOD = ['owner', 'admin', 'moderator'], ADM = ['owner', 'admin'];
route('GET', '/api/staff/overview', staff(ALL), ctx => ({
  pendingReview: db.get("SELECT COUNT(*) c FROM users WHERE status='pending_review'").c,
  openReports: db.get("SELECT COUNT(*) c FROM reports WHERE status='open'").c,
  openTickets: db.get("SELECT COUNT(*) c FROM tickets WHERE status='open'").c,
  activeMembers: db.get("SELECT COUNT(*) c FROM users WHERE status='active'").c,
  recent: ADM.includes(ctx.user.staff_role) ? db.all('SELECT at,who,text FROM audit ORDER BY id DESC LIMIT 8') : []
}));
route('GET', '/api/staff/queue', staff(MOD), () => ({
  queue: db.all("SELECT id,name,kind,org,title,email,review_reason AS reason,created_at FROM users WHERE status='pending_review' ORDER BY id")
}));
route('POST', '/api/staff/queue/:id', staff(MOD), async ctx => {
  const u = db.get("SELECT * FROM users WHERE id=? AND status='pending_review'", ctx.params.id);
  if (!u) throw new HttpError(404, 'That sign-up was already handled.');
  const d = ctx.body.decision;
  if (d === 'approve') {
    db.run("UPDATE users SET status='active' WHERE id=?", u.id);
    const dom = u.email.split('@')[1];
    if (ctx.body.trustDomain && u.kind === 'industry' && ADM.includes(ctx.user.staff_role)) { const a = setting('approved'); if (!a.includes(dom)) { a.push(dom); setSetting('approved', a); audit(ctx.user, 'Added ' + dom + ' to approved company domains'); } }
    audit(ctx.user, 'Approved ' + u.name + ' (' + u.email + ')');
    await notify(u.email, 'Your Fixboard account is approved', 'Hi ' + u.name + ', your account has been approved. Sign in with your email to get started.');
  } else if (d === 'reject') {
    db.run("UPDATE users SET status='rejected' WHERE id=?", u.id);
    audit(ctx.user, 'Rejected ' + u.name + ' (' + u.email + ')');
    await notify(u.email, 'About your Fixboard account', 'Hi ' + u.name + ', we could not verify your account this time. If you think this is a mistake, reply to ' + SUPPORT_EMAIL + '.');
  } else throw bad('Choose approve or reject.');
});
function reportTarget(r) {
  if (r.type === 'problem') { const p = db.get('SELECT p.id,p.title,p.hidden,u.name,u.id uid FROM problems p JOIN users u ON u.id=p.user_id WHERE p.id=?', r.ref); return p && { label: 'Problem: ' + p.title, hidden: !!p.hidden, author: p.name, authorId: p.uid }; }
  const s = db.get('SELECT s.id,s.body,s.hidden,u.name,u.id uid FROM solutions s JOIN users u ON u.id=s.user_id WHERE s.id=?', r.ref);
  return s && { label: 'Solution: ' + s.body.slice(0, 120) + (s.body.length > 120 ? '…' : ''), hidden: !!s.hidden, author: s.name, authorId: s.uid };
}
route('GET', '/api/staff/reports', staff(MOD), () => ({
  reports: db.all('SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY (r.status=\'open\') DESC, r.id DESC LIMIT 200').map(r => ({ id: r.id, type: r.type, ref: r.ref, reason: r.reason, note: r.note, status: r.status, reporter: r.reporter, created: r.created_at, target: reportTarget(r) }))
}));
route('POST', '/api/staff/reports/:id', staff(MOD), ctx => {
  const r = db.get("SELECT * FROM reports WHERE id=? AND status='open'", ctx.params.id);
  if (!r) throw new HttpError(404, 'That report was already handled.');
  const a = ctx.body.action, t = reportTarget(r);
  if (a === 'dismiss') { db.run("UPDATE reports SET status='dismissed' WHERE id=?", r.id); audit(ctx.user, 'Dismissed report #' + r.id); return; }
  if (a === 'remove' || a === 'suspend') {
    if (a === 'suspend' && !ADM.includes(ctx.user.staff_role)) throw new HttpError(403, 'Your role cannot suspend members.');
    db.tx(() => {
      db.run(r.type === 'problem' ? 'UPDATE problems SET hidden=1 WHERE id=?' : 'UPDATE solutions SET hidden=1 WHERE id=?', r.ref);
      db.run("UPDATE reports SET status='actioned' WHERE id=?", r.id);
      if (a === 'suspend' && t) {
        const au = db.get('SELECT staff_role FROM users WHERE id=?', t.authorId);
        if (au && au.staff_role) throw bad('Staff accounts cannot be suspended from here.');
        db.run("UPDATE users SET status='suspended' WHERE id=?", t.authorId); db.run('DELETE FROM sessions WHERE user_id=?', t.authorId);
      }
    });
    audit(ctx.user, (a === 'suspend' ? 'Suspended ' + (t ? t.author : 'author') + ' and removed content' : 'Removed content') + ' after report #' + r.id);
    return;
  }
  throw bad('Choose an action.');
});
route('GET', '/api/staff/members', staff(['owner', 'admin', 'support']), () => {
  const pm = pointsMap(), th = setting('leagues');
  return { members: db.all("SELECT id,name,kind,org,title,email,status,staff_role FROM users WHERE status IN ('active','suspended') ORDER BY name").map(u => ({ id: u.id, name: u.name, kind: u.kind, org: u.org, email: u.email, status: u.status, staffRole: u.staff_role, league: leagueOf(pm.get(u.id) || 0, th) })) };
});
route('POST', '/api/staff/members/:id', staff(ADM), ctx => {
  const u = db.get('SELECT * FROM users WHERE id=?', ctx.params.id);
  if (!u) throw new HttpError(404, 'Member not found.');
  if (u.staff_role) throw new HttpError(403, 'Staff accounts are managed under Staff & access.');
  const a = ctx.body.action;
  if (a === 'suspend') { db.run("UPDATE users SET status='suspended' WHERE id=?", u.id); db.run('DELETE FROM sessions WHERE user_id=?', u.id); audit(ctx.user, 'Suspended ' + u.name); }
  else if (a === 'reinstate') { db.run("UPDATE users SET status='active' WHERE id=?", u.id); audit(ctx.user, 'Reinstated ' + u.name); }
  else throw bad('Choose an action.');
});
route('GET', '/api/staff/tickets', staff(ALL), () => {
  const ts = db.all('SELECT t.*, u.name AS uname, u.org AS uorg FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY (t.status=\'open\') DESC, t.id DESC LIMIT 200');
  const rep = db.all('SELECT * FROM ticket_replies ORDER BY id');
  return { tickets: ts.map(t => ({ id: t.id, cat: t.cat, subject: t.subject, body: t.body, status: t.status, from: t.uname + ', ' + t.uorg, created: t.created_at, replies: rep.filter(r => r.ticket_id === t.id).map(r => ({ who: r.who, body: r.body })) })) };
});
route('POST', '/api/staff/tickets/:id/reply', staff(ALL), async ctx => {
  const t = db.get('SELECT t.*, u.email AS uemail FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?', ctx.params.id);
  if (!t) throw new HttpError(404, 'Ticket not found.');
  const body = cleanText(ctx.body.body, 3000);
  if (body.length < 3) throw bad('Write a reply first.');
  db.run('INSERT INTO ticket_replies(ticket_id,who,body,created_at) VALUES(?,?,?,?)', t.id, 'Fixboard support', body, now());
  audit(ctx.user, 'Replied to ticket #' + t.id);
  await notify(t.uemail, 'Fixboard support replied: ' + t.subject, body + '\n\nYou can also see this reply on the Help page after you sign in.');
});
route('POST', '/api/staff/tickets/:id/close', staff(ALL), ctx => { db.run("UPDATE tickets SET status='closed' WHERE id=?", ctx.params.id); audit(ctx.user, 'Closed ticket #' + ctx.params.id); });

route('GET', '/api/staff/settings', staff(ADM), () => ({ leagues: setting('leagues'), flags: setting('flags'), blocked: setting('blocked'), approved: setting('approved'), announcement: setting('announcement') }));
route('PUT', '/api/staff/settings', staff(ADM), ctx => {
  const b = ctx.body;
  if (b.leagues) {
    const v = [b.leagues.silver, b.leagues.gold, b.leagues.platinum].map(x => parseInt(x, 10));
    if (v.some(isNaN) || !(v[0] > 0 && v[0] < v[1] && v[1] < v[2])) throw bad('Each league needs more points than the one before it.');
    const old = setting('leagues'); setSetting('leagues', { silver: v[0], gold: v[1], platinum: v[2] });
    audit(ctx.user, 'Changed league thresholds from ' + [old.silver, old.gold, old.platinum].join('/') + ' to ' + v.join('/'));
  }
  if (b.flags) {
    const f = setting('flags'), nf = {};
    Object.keys(DEFAULTS.flags).forEach(k => { nf[k] = b.flags[k] === undefined ? f[k] : !!b.flags[k]; if (nf[k] !== f[k]) audit(ctx.user, 'Turned ' + k + (nf[k] ? ' on' : ' off')); });
    setSetting('flags', nf);
  }
  if (Array.isArray(b.blocked)) {
    const list = [...new Set(b.blocked.map(x => String(x).trim().toLowerCase()).filter(x => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)))];
    setSetting('blocked', list); audit(ctx.user, 'Updated blocked email domains (' + list.length + ' domains)');
  }
  if (b.announcement !== undefined) {
    if (b.announcement === null) { setSetting('announcement', null); audit(ctx.user, 'Cleared the announcement'); }
    else { const text = clean(b.announcement.text, 300); if (!text) throw bad('Write the message first.'); setSetting('announcement', { text, level: b.announcement.level === 'maintenance' ? 'maintenance' : 'info' }); audit(ctx.user, 'Published announcement: ' + text); }
  }
});
route('GET', '/api/staff/audit', staff(ADM), () => ({ audit: db.all('SELECT at,who,text FROM audit ORDER BY id DESC LIMIT 300') }));
route('GET', '/api/staff/team', staff(['owner']), () => ({
  team: db.all("SELECT u.id,u.name,u.email,u.staff_role AS role,(SELECT MAX(last_seen) FROM sessions s WHERE s.user_id=u.id) AS seen FROM users u WHERE u.staff_role IS NOT NULL ORDER BY u.id").map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, founder: m.email === FOUNDER_EMAIL, lastSeen: m.seen })),
  invites: db.all('SELECT email, role FROM invites ORDER BY created_at')
}));
route('POST', '/api/staff/team/invite', staff(['owner']), async ctx => {
  const email = normEmail(ctx.body.email), role = ctx.body.role;
  if (!email) throw bad('Enter a full email address.');
  if (!['admin', 'moderator', 'support'].includes(role)) throw bad('Choose a role.');
  const existing = db.get('SELECT * FROM users WHERE email=?', email);
  if (existing) { db.run('UPDATE users SET staff_role=? WHERE id=?', role, existing.id); audit(ctx.user, 'Made ' + existing.name + ' ' + role); return; }
  db.run('INSERT INTO invites(email,role,created_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role', email, role, now());
  audit(ctx.user, 'Invited ' + email + ' as ' + role);
  await notify(email, 'You are invited to the Fixboard team', 'You have been invited to help run Fixboard as ' + role + '. Go to ' + BASE_URL + ' and choose Create account, enter your name and use this email address.');
});
route('POST', '/api/staff/team/invite/remove', staff(['owner']), ctx => { db.run('DELETE FROM invites WHERE email=?', String(ctx.body.email || '').toLowerCase()); audit(ctx.user, 'Cancelled an invite'); });
function teamTarget(ctx) {
  const u = db.get('SELECT * FROM users WHERE id=? AND staff_role IS NOT NULL', ctx.params.id);
  if (!u) throw new HttpError(404, 'Staff member not found.');
  if (u.email === FOUNDER_EMAIL) throw new HttpError(403, 'The founder account cannot be changed here.');
  return u;
}
route('POST', '/api/staff/team/:id/role', staff(['owner']), ctx => {
  const u = teamTarget(ctx), role = ctx.body.role;
  if (!['admin', 'moderator', 'support'].includes(role)) throw bad('Choose a role.');
  db.run('UPDATE users SET staff_role=? WHERE id=?', role, u.id); db.run('DELETE FROM sessions WHERE user_id=?', u.id);
  audit(ctx.user, 'Changed ' + u.name + ' from ' + u.staff_role + ' to ' + role);
});
route('POST', '/api/staff/team/:id/signout', staff(['owner']), ctx => {
  const u = db.get('SELECT * FROM users WHERE id=? AND staff_role IS NOT NULL', ctx.params.id);
  if (!u) throw new HttpError(404, 'Staff member not found.');
  db.run('DELETE FROM sessions WHERE user_id=?', u.id); audit(ctx.user, 'Ended all sessions for ' + u.name);
});
route('POST', '/api/staff/team/:id/remove', staff(['owner']), ctx => {
  const u = teamTarget(ctx);
  db.run('UPDATE users SET staff_role=NULL WHERE id=?', u.id); db.run('DELETE FROM sessions WHERE user_id=?', u.id);
  audit(ctx.user, 'Removed staff access for ' + u.name);
});

/* ---------- start ---------- */
const server = http.createServer((req, res) => { handle(req, res); });
if (require.main === module) {
  db.run("DELETE FROM sessions WHERE expires_at<?", now());
  server.listen(PORT, () => console.log('Fixboard running on ' + BASE_URL + (PROD ? '' : '  (development mode: emails print to this console)')));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { server };
