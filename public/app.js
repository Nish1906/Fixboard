'use strict';
const root = document.getElementById('app');
let ME = null, INFO = {}, view = 'board', staffTab = 'overview', toastT;

/* ---------- helpers ---------- */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in (attrs || {})) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  kids.flat(9).forEach(c => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return n;
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fixboard' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.status = r.status; e.data = j; throw e; }
  return j;
}
function toast(m) { clearTimeout(toastT); document.querySelectorAll('.toast').forEach(t => t.remove()); const t = el('div', { class: 'toast', role: 'status' }, m); document.body.append(t); toastT = setTimeout(() => t.remove(), 3500); }
function fail(e) { if (e.status === 401) return boot(); toast(e.message); }
const ago = iso => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const leagueBadge = l => el('span', { class: 'league l' + (l.idx + 1) }, l.name);
const who = a => el('span', null, el('strong', null, a.name), ' ', el('span', { class: 'muted small' }, (a.title ? a.title + ', ' : '') + a.org), ' ', leagueBadge(a.league));
const mark = () => el('img', { class: 'mark', src: '/favicon.svg', alt: '' });
function layout(...main) {
  const banner = INFO.announcement ? el('div', { class: 'banner ' + INFO.announcement.level, role: 'status' }, INFO.announcement.text) : null;
  root.replaceChildren(...[banner, ...main].filter(Boolean), el('footer', null, el('div', { class: 'wrap' }, 'Fixboard · Founded by ' + (INFO.founder || '') + ' · ', el('a', { href: '/terms' }, 'Terms'), ' · ', el('a', { href: '/privacy' }, 'Privacy'), ' · ', el('a', { href: '/rules' }, 'Community rules'))));
}

/* ---------- boot ---------- */
async function boot() {
  try { const j = await api('GET', '/api/me'); INFO = j; ME = j.user; if (ME) ME.league = j.league; } catch (e) { INFO = {}; ME = null; }
  if (!ME) return gate();
  if (ME.status !== 'active') return statusScreen();
  render();
}

/* ---------- gate ---------- */
function gate() {
  let mode = 'signup', kind = 'student', step = 1, email = '', msg = '';
  const draw = () => {
    const f = el('form', { onsubmit: submit, novalidate: true });
    const isNew = mode === 'signup';
    f.append(el('div', { class: 'tabs' },
      el('button', { type: 'button', class: mode === 'signup' ? 'on' : '', onclick: () => { mode = 'signup'; step = 1; msg = ''; draw(); } }, 'Create account'),
      el('button', { type: 'button', class: mode === 'signin' ? 'on' : '', onclick: () => { mode = 'signin'; step = 1; msg = ''; draw(); } }, 'Sign in')));
    if (step === 1) {
      if (isNew) f.append(el('div', { class: 'tabs' },
        el('button', { type: 'button', class: kind === 'student' ? 'on' : '', onclick: () => { kind = 'student'; draw(); } }, 'Student / job-seeker'),
        el('button', { type: 'button', class: kind === 'industry' ? 'on' : '', onclick: () => { kind = 'industry'; draw(); } }, 'Industry professional')));
      if (isNew) f.append(el('label', { for: 'name' }, 'Full name'), el('input', { id: 'name', autocomplete: 'name' }),
        el('label', { for: 'org' }, kind === 'student' ? 'School' : 'Company'), el('input', { id: 'org' }),
        el('label', { for: 'title' }, kind === 'student' ? 'Program (optional)' : 'Your role'), el('input', { id: 'title' }));
      f.append(el('label', { for: 'email' }, kind === 'student' || !isNew ? 'Email' : 'Work email'),
        el('input', { id: 'email', type: 'email', autocomplete: 'email', value: email, placeholder: isNew && kind === 'student' ? 'you@school.edu' : isNew ? 'you@company.com' : '' }),
        el('p', { class: 'muted small' }, isNew ? (kind === 'student' ? 'Use your school (.edu) email.' : 'Use your company email. Personal addresses are not accepted.') : 'We will email you a 6-digit code.'));
    } else f.append(el('p', null, 'We sent a 6-digit code to ', el('strong', null, email), '.'), el('label', { for: 'code' }, 'Code'), el('input', { id: 'code', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' }), msg ? el('div', { class: 'ok' }, msg) : null);
    f.append(el('div', { class: 'err', id: 'gerr', hidden: true }), el('button', { class: 'btn', style: 'width:100%;margin-top:12px', id: 'gbtn' }, step === 1 ? 'Email me a code' : 'Verify and enter'));
    if (step === 2) f.append(el('p', { class: 'small' }, el('a', { href: '#', onclick: e => { e.preventDefault(); step = 1; draw(); } }, 'Use a different email')));
    const holder = document.getElementById('gate'); holder.replaceChildren(f);
  };
  async function submit(e) {
    e.preventDefault();
    const err = document.getElementById('gerr'), btn = document.getElementById('gbtn'); err.hidden = true; btn.disabled = true;
    try {
      if (step === 1) {
        email = document.getElementById('email').value.trim();
        const body = { email };
        if (mode === 'signup') Object.assign(body, { kind, name: document.getElementById('name').value, org: document.getElementById('org').value, title: document.getElementById('title').value });
        let j = await api('POST', '/api/auth/start', body);
        if (j.needsProfile && mode === 'signin') { err.textContent = j.staffInvite ? 'You have a team invite. Choose Create account and enter your name.' : 'No account found for this email. Choose Create account.'; err.hidden = false; btn.disabled = false; return; }
        step = 2; msg = j.devCode ? 'Development mode code: ' + j.devCode : ''; draw();
      } else {
        const j = await api('POST', '/api/auth/verify', { email, code: document.getElementById('code').value });
        boot();
      }
    } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; }
  }
  layout(
    el('header', { class: 'top' }, el('div', { class: 'wrap' }, el('span', { class: 'brand' }, mark(), 'Fixboard'))),
    el('section', { class: 'hero' }, el('div', { class: 'wrap split' },
      el('div', null, el('h1', null, 'Real supply chain problems. ', el('em', null, 'Solved by verified people.')),
        el('p', null, 'Industry professionals post problems. Students and job-seekers send solutions. Everyone is verified with a work or school email, and only members can see the board.'),
        el('p', { class: 'small' }, 'Rate solutions, climb the leagues, and connect with people who have the skills you need.')),
      el('div', { class: 'gate', id: 'gate' }))));
  draw();
}
function statusScreen() {
  const s = ME.status, t = { pending_review: ['Your account is waiting for review', 'A member of the Fixboard team is checking your details. We will email ' + ME.email + ' as soon as you are approved.'], rejected: ['We could not verify your account', 'If you think this is a mistake, write to ' + INFO.support + '.'], suspended: ['Your account is suspended', 'Write to ' + INFO.support + ' if you have questions.'] }[s] || ['Account not active', ''];
  layout(el('div', { class: 'center card' }, el('h1', null, t[0]), el('p', { class: 'muted' }, t[1]), el('button', { class: 'btn ghost', onclick: logout }, 'Sign out')));
}
async function logout() { try { await api('POST', '/api/auth/logout', {}); } catch (e) {} ME = null; boot(); }

/* ---------- shell ---------- */
const NAV = [['board', 'Board'], ['people', 'People'], ['leagues', 'Leagues'], ['profile', 'Profile'], ['help', 'Help']];
function shell(content) {
  const tabs = NAV.concat(ME.staffRole ? [['staff', 'Staff console']] : []);
  layout(el('header', { class: 'top' }, el('div', { class: 'wrap' }, el('span', { class: 'brand' }, mark(), 'Fixboard'),
    el('nav', null, tabs.map(([k, l]) => el('button', { class: view === k ? 'on' : '', onclick: () => { view = k; render(); } }, l))),
    el('span', { class: 'small muted' }, ME.name), el('button', { class: 'btn ghost sm', onclick: logout }, 'Sign out'))), el('main', { class: 'wrap' }, content));
}
async function render() {
  try {
    const fn = { board: vBoard, people: vPeople, leagues: vLeagues, profile: vProfile, help: vHelp, staff: vStaff }[view];
    const c = await fn(); shell(c); window.scrollTo(0, 0);
  } catch (e) { fail(e); }
}
const refresh = async () => { const y = window.scrollY; await render(); window.scrollTo(0, y); };

/* ---------- board ---------- */
async function vBoard() {
  const { problems } = await api('GET', '/api/board');
  const out = el('div', null, el('div', { class: 'row between' }, el('h1', null, 'Problem board'),
    ME.kind === 'industry' ? el('button', { class: 'btn', onclick: () => postForm(out) }, 'Post a problem') : el('span', { class: 'muted small' }, 'Students send solutions on any open problem.')));
  if (!problems.length) out.append(el('div', { class: 'card muted' }, 'No problems yet. Industry members can post the first one.'));
  problems.forEach(p => out.append(problemCard(p)));
  return out;
}
function postForm(out) {
  if (document.getElementById('pform')) return;
  let tags = [];
  const f = el('form', { id: 'pform', class: 'card', onsubmit: async e => { e.preventDefault(); try { await api('POST', '/api/problems', { title: f.title.value, body: f.body.value, tags }); toast('Problem posted.'); render(); } catch (x) { fail(x); } } },
    el('h2', null, 'Post a problem'), el('label', null, 'Title'), el('input', { name: 'title', maxlength: 140 }),
    el('label', null, 'What is happening? Leave out company secrets and names.'), el('textarea', { name: 'body' }),
    el('label', null, 'Skills that would help'), el('div', { class: 'chips' }, INFO.skills.map(s => el('button', { type: 'button', class: 'chip', onclick: e => { tags = tags.includes(s) ? tags.filter(x => x !== s) : tags.concat(s); e.target.classList.toggle('on'); } }, s))),
    el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'btn' }, 'Post'), el('button', { type: 'button', class: 'btn ghost', onclick: () => f.remove() }, 'Cancel')));
  out.children[0].after(f);
}
function problemCard(p) {
  const c = el('div', { class: 'card' }, el('div', { class: 'row between' }, el('h3', null, p.title), el('span', { class: 'pill ' + (p.status === 'solved' ? 'ok' : '') }, p.status === 'solved' ? 'Solved' : 'Open')),
    el('div', { class: 'small' }, who(p.author), ' · ', ago(p.created)), el('p', { style: 'white-space:pre-wrap' }, p.body),
    p.tags.length ? el('div', { class: 'chips' }, p.tags.map(t => el('span', { class: 'chip' }, t))) : null,
    el('div', { class: 'row small', style: 'margin-top:8px' }, el('strong', null, p.solutions.length + (p.solutions.length === 1 ? ' solution' : ' solutions')), p.own ? null : el('a', { href: '#', onclick: e => { e.preventDefault(); reportForm('problem', p.id, c); } }, 'Report')));
  p.solutions.forEach(s => c.append(solutionRow(p, s)));
  if (ME.kind === 'student' && p.status === 'open' && !p.own) c.append(el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn sm', onclick: e => solveForm(p, e.target) }, 'Send a solution')));
  return c;
}
function solveForm(p, btn) {
  const f = el('form', { onsubmit: async e => { e.preventDefault(); try { await api('POST', '/api/problems/' + p.id + '/solutions', { body: f.body.value }); toast('Solution sent.'); refresh(); } catch (x) { fail(x); } } },
    el('textarea', { name: 'body', placeholder: 'Explain how you would solve it, with steps or numbers where you can.' }), el('div', { class: 'row' }, el('button', { class: 'btn sm' }, 'Send'), el('button', { type: 'button', class: 'btn ghost sm', onclick: () => { f.replaceWith(btn); } }, 'Cancel')));
  btn.replaceWith(f);
}
function solutionRow(p, s) {
  const stars = el('div', { class: 'stars', 'aria-label': 'Rate this solution' }, [1, 2, 3, 4, 5].map(n => el('button', { type: 'button', class: s.mine >= n ? 'on' : '', 'aria-label': n + ' stars', disabled: s.own, onclick: async () => { try { const j = await api('PUT', '/api/solutions/' + s.id + '/rating', { stars: s.mine === n ? 0 : n }); toast(j.movedUp ? j.authorName + ' moved up to ' + j.movedUp + '!' : 'Rating saved.'); refresh(); } catch (x) { fail(x); } } }, '★')));
  return el('div', { class: 'sol' + (s.accepted ? ' acc' : '') }, el('div', { class: 'row between small' }, who(s.author), s.accepted ? el('span', { class: 'pill ok' }, 'Accepted') : null),
    el('p', { style: 'white-space:pre-wrap;margin:6px 0' }, s.body),
    el('div', { class: 'row small' }, INFO.flags.ratings ? stars : null, s.count ? el('span', { class: 'muted' }, s.avg.toFixed(1) + ' (' + s.count + ')') : el('span', { class: 'muted' }, 'No ratings yet'),
      p.own && p.status === 'open' ? el('button', { class: 'btn sm', onclick: async () => { try { const j = await api('POST', '/api/solutions/' + s.id + '/accept', {}); toast(j.movedUp ? 'Accepted. ' + s.author.name + ' moved up to ' + j.movedUp + '!' : 'Marked as accepted.'); refresh(); } catch (x) { fail(x); } } }, 'Accept') : null,
      s.own ? null : el('a', { href: '#', onclick: e => { e.preventDefault(); reportForm('solution', s.id, e.target.closest('.sol')); } }, 'Report')));
}
function reportForm(type, ref, host) {
  if (host.querySelector('.rform')) return;
  const sel = el('select', null, INFO.reasons.map(r => el('option', null, r)));
  const note = el('input', { placeholder: 'Optional note' });
  const f = el('div', { class: 'rform card' }, el('strong', null, 'Report this'), sel, note, el('div', { class: 'row', style: 'margin-top:8px' },
    el('button', { class: 'btn sm', onclick: async () => { try { await api('POST', '/api/reports', { type, ref, reason: sel.value, note: note.value }); toast('Thanks. The team will take a look.'); f.remove(); } catch (x) { fail(x); } } }, 'Send report'), el('button', { class: 'btn ghost sm', onclick: () => f.remove() }, 'Cancel')));
  host.append(f);
}

/* ---------- people ---------- */
async function vPeople() {
  const [{ people }, ints] = await Promise.all([api('GET', '/api/people'), api('GET', '/api/intros')]);
  const out = el('div', null, el('h1', null, 'People'));
  if (ints.incoming.some(i => i.status === 'pending')) {
    out.append(el('div', { class: 'card' }, el('h2', null, 'Intro requests for you'), ints.incoming.filter(i => i.status === 'pending').map(i => el('div', { class: 'row between', style: 'padding:6px 0' }, el('span', null, el('strong', null, i.name), ' ', el('span', { class: 'muted small' }, i.title + ', ' + i.org)),
      el('span', { class: 'row' }, ['accepted', 'declined'].map(d => el('button', { class: 'btn sm ' + (d === 'declined' ? 'ghost' : ''), onclick: async () => { try { await api('POST', '/api/intros/' + i.id, { decision: d }); refresh(); } catch (x) { fail(x); } } }, d === 'accepted' ? 'Accept' : 'Decline')))))));
  }
  const accepted = ints.incoming.concat(ints.outgoing).filter(i => i.status === 'accepted');
  if (accepted.length) out.append(el('div', { class: 'card' }, el('h2', null, 'Your connections'), accepted.map(i => el('div', { class: 'small', style: 'padding:4px 0' }, el('strong', null, i.name), ' · ', i.org, ' · ', el('a', { href: 'mailto:' + i.email }, i.email)))));
  let filter = '';
  const list = el('div');
  const draw = () => { list.replaceChildren(...people.filter(p => !filter || p.skills.includes(filter)).map(p => el('div', { class: 'card row between' }, el('div', null, who(p), el('div', { class: 'chips', style: 'margin-top:6px' }, p.skills.map(s => el('span', { class: 'chip' }, s)))),
    INFO.flags.intros ? (p.intro ? el('span', { class: 'pill' }, p.intro === 'pending' ? 'Requested' : p.intro === 'accepted' ? 'Connected' : 'Declined') : el('button', { class: 'btn sm', onclick: async () => { try { await api('POST', '/api/intros', { to: p.id }); toast('Intro request sent.'); refresh(); } catch (x) { fail(x); } } }, 'Request intro')) : null))); if (!list.children.length) list.append(el('div', { class: 'card muted' }, 'No members match yet.')); };
  out.append(el('div', { class: 'chips', style: 'margin:8px 0' }, el('button', { class: 'chip on', onclick: e => pick(e, '') }, 'All'), INFO.skills.map(s => el('button', { class: 'chip', onclick: e => pick(e, s) }, s))), list);
  function pick(e, s) { filter = s; e.target.parentNode.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); e.target.classList.add('on'); draw(); }
  draw(); return out;
}

/* ---------- leagues ---------- */
async function vLeagues() {
  const j = await api('GET', '/api/leagues'), t = j.thresholds, mine = j.members.find(m => m.id === j.me);
  const l = mine.league, out = el('div', null, el('h1', null, 'Leagues'));
  out.append(el('div', { class: 'card' }, el('div', { class: 'row between' }, el('div', null, el('div', { class: 'muted small' }, 'Your league'), el('div', { class: 'stat' }, l.name)), el('div', { class: 'stat' }, mine.points + ' pts')),
    l.next ? [el('div', { class: 'bar', style: 'margin:10px 0' }, el('i', { style: 'width:' + Math.min(100, Math.round((mine.points - l.floor) / (l.need - l.floor) * 100)) + '%' })), el('div', { class: 'small muted' }, (l.need - mine.points) + ' points to ' + l.next)] : el('div', { class: 'small muted' }, 'You are in the top league.'),
    el('p', { class: 'small muted' }, 'You earn 1 point for each star others give your solutions and 10 points when a poster accepts one. Silver ' + t.silver + ' · Gold ' + t.gold + ' · Platinum ' + t.platinum + '.')));
  out.append(el('div', { class: 'card' }, el('table', null, el('tr', null, ['#', 'Member', 'Organization', 'League', 'Points'].map(h => el('th', null, h))), j.members.map((m, i) => el('tr', null, el('td', null, i + 1), el('td', null, m.name), el('td', { class: 'muted' }, m.org), el('td', null, leagueBadge(m.league)), el('td', null, m.points))))));
  return out;
}

/* ---------- profile and help ---------- */
async function vProfile() {
  let skills = ME.skills.slice();
  const f = el('form', { class: 'card', onsubmit: async e => { e.preventDefault(); try { await api('PUT', '/api/me/profile', { skills, title: f.title.value }); ME.skills = skills; toast('Profile saved.'); } catch (x) { fail(x); } } },
    el('div', { class: 'small muted' }, ME.kind === 'student' ? 'Student' : 'Industry', ' · ', ME.org, ' · ', ME.email), el('label', null, 'Role or program'), el('input', { name: 'title', value: ME.title }),
    el('label', null, 'Your skills'), el('div', { class: 'chips' }, INFO.skills.map(s => el('button', { type: 'button', class: 'chip' + (skills.includes(s) ? ' on' : ''), onclick: e => { skills = skills.includes(s) ? skills.filter(x => x !== s) : skills.concat(s); e.target.classList.toggle('on'); } }, s))),
    el('div', { style: 'margin-top:14px' }, el('button', { class: 'btn' }, 'Save')));
  return el('div', null, el('h1', null, 'Your profile'), f);
}
async function vHelp() {
  const { tickets } = await api('GET', '/api/tickets');
  const f = el('form', { class: 'card', onsubmit: async e => { e.preventDefault(); try { await api('POST', '/api/tickets', { cat: f.cat.value, subject: f.subject.value, body: f.body.value }); toast('Sent. We will reply by email.'); render(); } catch (x) { fail(x); } } },
    el('h2', null, 'Contact the team'), el('label', null, 'Topic'), el('select', { name: 'cat' }, INFO.cats.map(c => el('option', null, c))), el('label', null, 'Subject'), el('input', { name: 'subject' }), el('label', null, 'What happened?'), el('textarea', { name: 'body' }), el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn' }, 'Send')));
  return el('div', null, el('h1', null, 'Help'), f, tickets.map(t => el('div', { class: 'card' }, el('div', { class: 'row between' }, el('strong', null, t.subject), el('span', { class: 'pill' }, t.status)), el('p', { class: 'small', style: 'white-space:pre-wrap' }, t.body), t.replies.map(r => el('div', { class: 'ok' }, el('strong', null, r.who + ': '), r.body)))));
}

/* ---------- staff console ---------- */
const STAFF_TABS = { overview: ['Overview', ['owner', 'admin', 'moderator', 'support']], queue: ['Verification', ['owner', 'admin', 'moderator']], reports: ['Reports', ['owner', 'admin', 'moderator']], members: ['Members', ['owner', 'admin', 'support']], tickets: ['Support', ['owner', 'admin', 'moderator', 'support']], settings: ['Settings', ['owner', 'admin']], audit: ['Audit log', ['owner', 'admin']], team: ['Staff & access', ['owner']] };
async function vStaff() {
  const allowed = Object.entries(STAFF_TABS).filter(([, v]) => v[1].includes(ME.staffRole));
  if (!allowed.find(([k]) => k === staffTab)) staffTab = allowed[0][0];
  const body = await STAFF[staffTab]();
  return el('div', null, el('h1', null, 'Staff console'), el('div', { class: 'small muted' }, 'Signed in as ' + ME.staffRole + '. Sessions end after 30 minutes of inactivity.'),
    el('div', { class: 'chips', style: 'margin:10px 0' }, allowed.map(([k, v]) => el('button', { class: 'chip' + (staffTab === k ? ' on' : ''), onclick: () => { staffTab = k; render(); } }, v[0]))), body);
}
const act = (fn, msg) => async () => { try { await fn(); if (msg) toast(msg); refresh(); } catch (x) { fail(x); } };
const STAFF = {
  async overview() {
    const o = await api('GET', '/api/staff/overview');
    return el('div', null, el('div', { class: 'grid' }, [['Waiting for review', o.pendingReview], ['Open reports', o.openReports], ['Open tickets', o.openTickets], ['Active members', o.activeMembers]].map(([l, n]) => el('div', { class: 'card' }, el('div', { class: 'muted small' }, l), el('div', { class: 'stat' }, n)))),
      o.recent.length ? el('div', { class: 'card' }, el('h2', null, 'Recent activity'), el('table', null, o.recent.map(r => el('tr', null, el('td', { class: 'muted' }, ago(r.at)), el('td', null, r.who), el('td', null, r.text))))) : null);
  },
  async queue() {
    const { queue } = await api('GET', '/api/staff/queue');
    if (!queue.length) return el('div', { class: 'card muted' }, 'Nobody is waiting for review.');
    return queue.map(u => { const trust = el('input', { type: 'checkbox', style: 'width:auto' }); return el('div', { class: 'card' }, el('div', { class: 'row between' }, el('div', null, el('strong', null, u.name), ' ', el('span', { class: 'muted small' }, u.kind + ' · ' + u.org + ' · ' + u.title)), el('span', { class: 'pill warn' }, u.reason)), el('div', { class: 'small' }, u.email),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn sm', onclick: act(() => api('POST', '/api/staff/queue/' + u.id, { decision: 'approve', trustDomain: trust.checked }), 'Approved.') }, 'Approve'), el('button', { class: 'btn danger sm', onclick: act(() => api('POST', '/api/staff/queue/' + u.id, { decision: 'reject' }), 'Rejected.') }, 'Reject'),
        u.kind === 'industry' && ['owner', 'admin'].includes(ME.staffRole) ? el('label', { class: 'small row', style: 'margin:0;font-weight:400' }, trust, 'Trust ' + u.email.split('@')[1] + ' from now on') : null)); });
  },
  async reports() {
    const { reports } = await api('GET', '/api/staff/reports');
    if (!reports.length) return el('div', { class: 'card muted' }, 'No reports.');
    return reports.map(r => el('div', { class: 'card' }, el('div', { class: 'row between' }, el('strong', null, r.reason), el('span', { class: 'pill ' + (r.status === 'open' ? 'warn' : '') }, r.status)), el('p', { class: 'small' }, r.target ? r.target.label : 'Content removed'), el('div', { class: 'small muted' }, 'Reported by ' + r.reporter + ' ' + ago(r.created) + (r.note ? ' · ' + r.note : '')),
      r.status === 'open' ? el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn ghost sm', onclick: act(() => api('POST', '/api/staff/reports/' + r.id, { action: 'dismiss' })) }, 'Dismiss'), el('button', { class: 'btn sm', onclick: act(() => api('POST', '/api/staff/reports/' + r.id, { action: 'remove' }), 'Removed.') }, 'Remove content'),
        ['owner', 'admin'].includes(ME.staffRole) ? el('button', { class: 'btn danger sm', onclick: act(() => api('POST', '/api/staff/reports/' + r.id, { action: 'suspend' }), 'Suspended.') }, 'Remove and suspend author') : null) : null));
  },
  async members() {
    const { members } = await api('GET', '/api/staff/members'), canAct = ['owner', 'admin'].includes(ME.staffRole);
    return el('div', { class: 'card' }, el('table', null, el('tr', null, ['Name', 'Email', 'Organization', 'League', 'Status', ''].map(h => el('th', null, h))), members.map(m => el('tr', null, el('td', null, m.name), el('td', null, m.email), el('td', null, m.org), el('td', null, m.league.name), el('td', null, m.status),
      el('td', null, canAct && !m.staffRole ? el('button', { class: 'btn ghost sm', onclick: act(() => api('POST', '/api/staff/members/' + m.id, { action: m.status === 'active' ? 'suspend' : 'reinstate' })) }, m.status === 'active' ? 'Suspend' : 'Reinstate') : null)))));
  },
  async tickets() {
    const { tickets } = await api('GET', '/api/staff/tickets');
    if (!tickets.length) return el('div', { class: 'card muted' }, 'No tickets.');
    return tickets.map(t => { const ta = el('textarea', { placeholder: 'Write a reply', style: 'min-height:70px' }); return el('div', { class: 'card' }, el('div', { class: 'row between' }, el('strong', null, t.subject), el('span', { class: 'pill' }, t.status)), el('div', { class: 'small muted' }, t.from + ' · ' + t.cat + ' · ' + ago(t.created)), el('p', { class: 'small', style: 'white-space:pre-wrap' }, t.body), t.replies.map(r => el('div', { class: 'ok' }, r.body)),
      t.status === 'open' ? [ta, el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn sm', onclick: act(() => api('POST', '/api/staff/tickets/' + t.id + '/reply', { body: ta.value }), 'Reply sent.') }, 'Reply by email'), el('button', { class: 'btn ghost sm', onclick: act(() => api('POST', '/api/staff/tickets/' + t.id + '/close', {})) }, 'Close'))] : null); });
  },
  async settings() {
    const s = await api('GET', '/api/staff/settings'), L = s.leagues;
    const inp = (v) => el('input', { type: 'number', min: 1, value: v });
    const si = inp(L.silver), gi = inp(L.gold), pi = inp(L.platinum);
    const ann = el('input', { placeholder: 'Message for all members', value: s.announcement ? s.announcement.text : '' }), lvl = el('select', null, el('option', { value: 'info' }, 'Info'), el('option', { value: 'maintenance' }, 'Maintenance'));
    const blocked = el('textarea', null, s.blocked.join('\n'));
    const flag = k => el('label', { class: 'row', style: 'font-weight:400' }, el('input', { type: 'checkbox', style: 'width:auto', checked: s.flags[k], onchange: e => act(() => api('PUT', '/api/staff/settings', { flags: { [k]: e.target.checked } }), 'Saved.')() }), { ratings: 'Ratings on', leagues: 'Leagues on', intros: 'Intro requests on' }[k]);
    return el('div', null,
      el('div', { class: 'card' }, el('h2', null, 'League thresholds (points)'), el('div', { class: 'grid' }, el('div', null, el('label', null, 'Silver'), si), el('div', null, el('label', null, 'Gold'), gi), el('div', null, el('label', null, 'Platinum'), pi)), el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn sm', onclick: act(() => api('PUT', '/api/staff/settings', { leagues: { silver: si.value, gold: gi.value, platinum: pi.value } }), 'Saved.') }, 'Save thresholds'))),
      el('div', { class: 'card' }, el('h2', null, 'Features'), ['ratings', 'leagues', 'intros'].map(flag)),
      el('div', { class: 'card' }, el('h2', null, 'Announcement banner'), ann, lvl, el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn sm', onclick: act(() => api('PUT', '/api/staff/settings', { announcement: { text: ann.value, level: lvl.value } }), 'Published.') }, 'Publish'), el('button', { class: 'btn ghost sm', onclick: act(() => api('PUT', '/api/staff/settings', { announcement: null }), 'Cleared.') }, 'Clear'))),
      el('div', { class: 'card' }, el('h2', null, 'Blocked personal email domains'), el('p', { class: 'small muted' }, 'One per line. Approved company domains: ' + (s.approved.join(', ') || 'none yet')), blocked, el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn sm', onclick: act(() => api('PUT', '/api/staff/settings', { blocked: blocked.value.split('\n') }), 'Saved.') }, 'Save list'))));
  },
  async audit() {
    const { audit } = await api('GET', '/api/staff/audit');
    return el('div', { class: 'card' }, el('table', null, el('tr', null, ['When', 'Who', 'What'].map(h => el('th', null, h))), audit.map(a => el('tr', null, el('td', { class: 'muted' }, new Date(a.at).toLocaleString()), el('td', null, a.who), el('td', null, a.text)))));
  },
  async team() {
    const { team, invites } = await api('GET', '/api/staff/team'), em = el('input', { type: 'email', placeholder: 'colleague@company.com' }), rl = el('select', null, ['admin', 'moderator', 'support'].map(r => el('option', null, r)));
    return el('div', null, el('div', { class: 'card' }, el('table', null, el('tr', null, ['Name', 'Email', 'Role', ''].map(h => el('th', null, h))), team.map(m => el('tr', null, el('td', null, m.name, m.founder ? ' (founder)' : ''), el('td', null, m.email),
      el('td', null, m.founder ? 'owner' : (() => { const s = el('select', { onchange: act(() => api('POST', '/api/staff/team/' + m.id + '/role', { role: s.value }), 'Role changed.') }, ['admin', 'moderator', 'support'].map(r => el('option', { selected: r === m.role }, r))); return s; })()),
      el('td', { class: 'row' }, el('button', { class: 'btn ghost sm', onclick: act(() => api('POST', '/api/staff/team/' + m.id + '/signout', {}), 'Signed out everywhere.') }, 'End sessions'), m.founder ? null : el('button', { class: 'btn danger sm', onclick: act(() => api('POST', '/api/staff/team/' + m.id + '/remove', {}), 'Access removed.') }, 'Remove access')))))),
      el('div', { class: 'card' }, el('h2', null, 'Invite a team member'), el('div', { class: 'row' }, el('div', { class: 'grow' }, em), rl, el('button', { class: 'btn', onclick: act(() => api('POST', '/api/staff/team/invite', { email: em.value, role: rl.value }), 'Invite sent.') }, 'Invite')),
        invites.map(i => el('div', { class: 'row between small', style: 'padding:6px 0' }, el('span', null, i.email + ' · ' + i.role + ' · waiting'), el('button', { class: 'btn ghost sm', onclick: act(() => api('POST', '/api/staff/team/invite/remove', { email: i.email })) }, 'Cancel')))));
  }
};

boot();
