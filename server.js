'use strict';
/* KUNAI online server: serves the game and runs every online room authoritatively. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./shared/engine.js');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['../shared/engine.js', 'text/javascript; charset=utf-8'],
};
const cache = {};
function file(p) {
  if (!cache[p] || process.env.NODE_ENV !== 'production') cache[p] = fs.readFileSync(path.join(PUB, p));
  return cache[p];
}

/* ---------- password gate ---------- */
// Set SITE_PASSWORD in Railway → Variables to change it. Empty string turns the gate off.
const SITE_PASSWORD = process.env.SITE_PASSWORD !== undefined ? process.env.SITE_PASSWORD : 'KUNAI2026';
const GATE_KEY = crypto.createHash('sha256').update('kunai-gate:' + SITE_PASSWORD).digest();
const passToken = () => crypto.createHmac('sha256', GATE_KEY).update('ok').digest('hex');
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function authed(req) {
  if (!SITE_PASSWORD) return true;
  const c = cookies(req).kunai_pass || '';
  const t = passToken();
  return c.length === t.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(t));
}
const tries = new Map(); // ip -> [count, windowStart]
function tooMany(ip) {
  const now = Date.now(); const t = tries.get(ip) || [0, now];
  if (now - t[1] > 10 * 60 * 1000) { t[0] = 0; t[1] = now; }
  t[0]++; tries.set(ip, t); return t[0] > 12;
}
const safeNext = n => (typeof n === 'string' && /^\/(\?room=[A-Z]{4})?$/.test(n)) ? n : '/';
function loginPage(next, err) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KUNAI</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bungee&family=Permanent+Marker&family=Chakra+Petch:wght@600;700&display=swap">
<style>*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:16px;font-family:"Chakra Petch",system-ui,sans-serif;color:#f6f5fb;overflow:hidden;
background:radial-gradient(circle,rgba(0,0,0,.18) 1.4px,transparent 1.9px) 0 0/10px 10px,repeating-conic-gradient(from 0deg at 50% 110%,rgba(255,255,255,.1) 0 6deg,transparent 6deg 14deg),linear-gradient(160deg,#3a0f7a,#a3127f 55%,#ff5a3c)}
.box{width:min(420px,100%);text-align:center;display:flex;flex-direction:column;gap:18px;align-items:center}
h1{margin:0;font-family:Bungee,Impact,sans-serif;font-weight:400;font-size:clamp(72px,22vw,120px);line-height:.9;color:#ffd60a;-webkit-text-stroke:6px #07070b;paint-order:stroke fill;text-shadow:7px 7px 0 #ff4fa3,-5px -4px 0 #2f8bff;transform:rotate(-4deg)}
.st{font-family:"Permanent Marker",cursive;font-size:22px;background:#ff4fa3;color:#fff;border:4px solid #07070b;padding:2px 16px 6px;transform:rotate(-3deg);box-shadow:5px 5px 0 #07070b}
form{width:100%;background:rgba(22,12,44,.88);border:3px solid #07070b;border-radius:16px;box-shadow:0 7px 0 #000;padding:18px;display:flex;flex-direction:column;gap:12px}
label{font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#c9c3e0;text-align:left}
input{font:inherit;font-size:20px;letter-spacing:.12em;text-transform:uppercase;padding:12px 14px;border-radius:10px;border:3px solid #2c2c40;background:#120a26;color:#fff;width:100%}
input:focus{outline:none;border-color:#ffd60a}
button{font-family:Bungee,Impact,sans-serif;font-size:26px;padding:12px;border:3px solid #07070b;border-radius:12px;color:#07070b;cursor:pointer;background:linear-gradient(180deg,#ffe866,#ffc400 55%,#ffb000);box-shadow:0 7px 0 #a86a00,0 10px 0 #000}
button:active{transform:translateY(5px);box-shadow:0 2px 0 #a86a00,0 5px 0 #000}
.err{margin:0;color:#fff;background:#ff3b2f;border:2px solid #07070b;border-radius:8px;padding:6px 10px;font-weight:700}
</style></head><body><div class="box"><h1>KUNAI</h1><div class="st">COMING SOON</div>
<form method="post" action="/login"><input type="hidden" name="next" value="${next}"><label for="pw">Access code</label>
<input id="pw" name="pw" type="password" autocomplete="current-password" autofocus required>
${err ? `<p class="err">${err}</p>` : ''}<button type="submit">ENTER</button></form></div></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        const f = new URLSearchParams(body); const next = safeNext(f.get('next'));
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (tooMany(ip)) { res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' }); return res.end(loginPage(next, 'Too many tries. Wait a few minutes.')); }
        if (String(f.get('pw') || '').trim().toUpperCase() === SITE_PASSWORD.toUpperCase()) {
          tries.delete(ip);
          const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
          res.writeHead(303, { 'set-cookie': `kunai_pass=${passToken()}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${secure}`, location: next });
          return res.end();
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(loginPage(next, 'Wrong code. Try again.'));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(loginPage(safeNext(url.searchParams.get('next')), ''));
  }
  if (!authed(req)) {
    const next = safeNext(url.pathname + (url.searchParams.get('room') ? '?room=' + url.searchParams.get('room').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) : ''));
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(302, { location: '/login?next=' + encodeURIComponent(next) }); return res.end(); }
    res.writeHead(401); return res.end('Locked');
  }
  const f = FILES[url.pathname];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-cache' });
  res.end(file(f[0]));
});

/* ---------- rooms ---------- */
const rooms = new Map(); // code -> room
const GRACE_MS = 45000;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => { let c; do { c = Array.from({ length: 4 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join(''); } while (rooms.has(c)); return c; };
const newToken = () => crypto.randomBytes(16).toString('hex');
const clean = (s, n = 12) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) || 'Shinobi';
const NINJA_NAMES = ['Finn', 'Ember', 'Hex', 'Byte', 'King', 'Momo'];

function sanitizeSettings(s = {}) {
  return {
    bluff: !!s.bluff, stack: !!s.stack, until: !!s.until, skills: s.skills !== false,
    target: [0, 100, 250, 500].includes(+s.target) ? +s.target : 0,
    seats: Math.min(4, Math.max(2, +s.seats || 4)),
  };
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function lobbyMsg(room, member) {
  return {
    type: 'lobby', code: room.code, settings: room.settings, started: !!room.S,
    you: member.token === room.hostToken ? 'host' : 'guest',
    players: room.members.map(m => ({ name: m.name, av: m.av, skin: m.skin || 0, host: m.token === room.hostToken, you: m === member, online: !!m.ws })),
  };
}
function broadcastLobby(room) { room.members.forEach(m => send(m.ws, lobbyMsg(room, m))); }

/* each player only sees their own hand */
function viewFor(S, seat) {
  const o = { ...S, deckN: S.deck.length, deck: undefined, discard: undefined };
  o.players = S.players.map((p, i) => ({ ...p, token: undefined, hand: i === seat ? p.hand.slice() : p.hand.map(() => '??') }));
  if (S.pending) o.pending = { ...S.pending, actual: undefined };
  return o;
}
function broadcastState(room) {
  const S = room.S; if (!S) return;
  room.members.forEach(m => {
    const seat = S.players.findIndex(p => p.token === m.token);
    send(m.ws, { type: 'state', you: seat, state: viewFor(S, seat) });
  });
}
function commit(room) { room.S.v++; broadcastState(room); scheduleBots(room); }

function scheduleBots(room) {
  clearTimeout(room.botTimer);
  const S = room.S;
  if (!S || S.phase !== 'play') return;
  const who = S.pending ? S.pending.target : S.turn;
  if (!S.players[who].bot) return;
  const fxExtra = (S.fx && S.fx.id !== room.schedFx) ? 950 : 0; room.schedFx = S.fx ? S.fx.id : 0;
  room.botTimer = setTimeout(() => {
    if (!room.S || room.S.phase !== 'play') return;
    const w = S.pending ? S.pending.target : S.turn; if (!S.players[w].bot) return;
    let e = E.act(S, w, E.botAct(S, w));
    if (e) e = E.act(S, w, { t: S.drew ? 'pass' : 'draw' });
    if (e && S.pending && S.pending.target === w) E.act(S, w, { t: 'respond', liar: false });
    commit(room);
  }, (S.pending ? 1300 : 750 + Math.random() * 600) + fxExtra);
}

function startGame(room) {
  const humans = room.members.slice(0, 4).map(m => ({ name: m.name, av: m.av, skin: m.skin || 0, tro: m.tro || 0, bot: false, token: m.token }));
  const total = Math.max(room.settings.seats, humans.length);
  const used = new Set(humans.map(h => h.av));
  const bots = [];
  for (const i of E.shuffle([0, 1, 2, 3, 4, 5])) { if (humans.length + bots.length >= total) break; if (!used.has(i)) { bots.push({ name: NINJA_NAMES[i], av: i, skin: 0, tro: 40 + crypto.randomInt(700), bot: true, token: null }); used.add(i); } }
  room.S = E.newGame([...humans, ...bots], room.settings);
  room.S.gid = Date.now();
  commit(room);
}

function seatOf(room, member) { return room.S ? room.S.players.findIndex(p => p.token === member.token) : -1; }

function dropMember(room, member) {
  member.ws = null;
  if (!room.S) {
    // in the lobby a closed tab leaves the room
    room.members = room.members.filter(m => m !== member);
    if (member.token === room.hostToken && room.members[0]) room.hostToken = room.members[0].token;
    if (!room.members.length) return closeRoom(room);
    return broadcastLobby(room);
  }
  clearTimeout(member.graceTimer);
  member.graceTimer = setTimeout(() => {
    if (member.ws) return;
    const i = seatOf(room, member);
    if (i >= 0 && !room.S.players[i].bot) {
      room.S.players[i].bot = true;
      E.logp(room.S, `<b>${E.esc(room.S.players[i].name)}</b> disconnected. A bot takes over.`);
      commit(room);
    }
  }, GRACE_MS);
  if (!room.members.some(m => m.ws)) {
    clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => { if (!room.members.some(m => m.ws)) closeRoom(room); }, 10 * 60 * 1000);
  }
}
function closeRoom(room) { clearTimeout(room.botTimer); clearTimeout(room.idleTimer); rooms.delete(room.code); }

/* ---------- sockets ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024, verifyClient: info => authed(info.req) });
wss.on('connection', ws => {
  let room = null, me = null;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  let budget = 30, last = Date.now();

  ws.on('message', raw => {
    const now = Date.now(); budget = Math.min(30, budget + (now - last) / 100); last = now;
    if (--budget < 0) return; // flood guard
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'create') {
      if (room) return;
      const code = newCode();
      room = { code, settings: sanitizeSettings(m.settings), members: [], S: null, hostToken: null };
      rooms.set(code, room);
      me = { token: newToken(), name: clean(m.name), av: (+m.av | 0) % 6, skin: (+m.skin | 0) % 4, tro: Math.max(0, Math.min(99999, +m.tro | 0)), ws };
      room.hostToken = me.token; room.members.push(me);
      send(ws, { type: 'joined', code, token: me.token });
      return broadcastLobby(room);
    }
    if (m.type === 'join') {
      if (room) return;
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '');
      const r = rooms.get(code);
      if (!r) return send(ws, { type: 'error', msg: 'No room with that code. Check it with your friend.' });
      const back = m.token && r.members.find(x => x.token === m.token);
      if (back) {
        room = r; me = back; clearTimeout(me.graceTimer); clearTimeout(room.idleTimer);
        if (me.ws && me.ws !== ws) try { me.ws.close(4000, 'replaced'); } catch {}
        me.ws = ws;
        const i = seatOf(room, me);
        if (i >= 0 && room.S.players[i].bot) { room.S.players[i].bot = false; E.logp(room.S, `<b>${E.esc(me.name)}</b> is back.`); room.S.v++; }
        send(ws, { type: 'joined', code, token: me.token });
        broadcastLobby(room);
        if (room.S) { broadcastState(room); scheduleBots(room); }
        return;
      }
      if (r.S) return send(ws, { type: 'error', msg: 'That game has already started.' });
      if (r.members.length >= 4) return send(ws, { type: 'error', msg: 'That room is full.' });
      room = r; me = { token: newToken(), name: clean(m.name), av: (+m.av | 0) % 6, skin: (+m.skin | 0) % 4, tro: Math.max(0, Math.min(99999, +m.tro | 0)), ws };
      room.members.push(me);
      send(ws, { type: 'joined', code, token: me.token });
      return broadcastLobby(room);
    }
    if (!room || !me) return;

    if (m.type === 'settings' && me.token === room.hostToken && !room.S) { room.settings = sanitizeSettings(m.settings); return broadcastLobby(room); }
    if (m.type === 'start' && me.token === room.hostToken && !room.S) return startGame(room);
    if (m.type === 'leave') {
      const i = seatOf(room, me);
      if (room.S && i >= 0) { room.S.players[i].bot = true; E.logp(room.S, `<b>${E.esc(me.name)}</b> left. A bot takes over.`); commit(room); }
      room.members = room.members.filter(x => x !== me);
      if (me.token === room.hostToken && room.members[0]) room.hostToken = room.members[0].token;
      const r = room; room = null; me.ws = null; me = null;
      if (!r.members.length) closeRoom(r); else broadcastLobby(r);
      return;
    }
    if (m.type === 'emote' && room.S) {
      const seat = seatOf(room, me); const e = +m.e | 0;
      if (seat < 0 || e < 0 || e > 5 || Date.now() - (me.emoT || 0) < 1200) return;
      me.emoT = Date.now();
      room.members.forEach(x => send(x.ws, { type: 'emote', seat, e }));
      return;
    }
    if (m.type === 'act' && room.S) {
      const a = m.a || {};
      let seat = seatOf(room, me);
      if (seat < 0) return;
      if (a.t === 'next' || a.t === 'again') {
        // the host continues; if the host's seat is a bot, anyone may
        const host = room.S.players[0];
        if (seat !== 0 && !(host.bot)) return send(ws, { type: 'error', msg: 'Only the host starts the next round.' });
        seat = 0;
      }
      const e = E.act(room.S, seat, a);
      if (e) return send(ws, { type: 'error', msg: e });
      return commit(room);
    }
  });
  ws.on('close', () => { if (room && me && me.ws === ws) dropMember(room, me); });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }), 25000);

server.listen(PORT, () => console.log('KUNAI server on :' + PORT));
