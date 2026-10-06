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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
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
    players: room.members.map(m => ({ name: m.name, av: m.av, host: m.token === room.hostToken, you: m === member, online: !!m.ws })),
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
  const humans = room.members.slice(0, 4).map(m => ({ name: m.name, av: m.av, bot: false, token: m.token }));
  const total = Math.max(room.settings.seats, humans.length);
  const used = new Set(humans.map(h => h.av));
  const bots = [];
  for (const i of E.shuffle([0, 1, 2, 3, 4, 5])) { if (humans.length + bots.length >= total) break; if (!used.has(i)) { bots.push({ name: NINJA_NAMES[i], av: i, bot: true, token: null }); used.add(i); } }
  room.S = E.newGame([...humans, ...bots], room.settings);
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
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
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
      me = { token: newToken(), name: clean(m.name), av: (+m.av | 0) % 6, ws };
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
      room = r; me = { token: newToken(), name: clean(m.name), av: (+m.av | 0) % 6, ws };
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
