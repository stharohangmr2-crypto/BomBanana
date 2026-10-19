'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/config');
const { RoomManager, RateLimiter, sanitizeNick, normalizeCode } = require('../src/rooms');
const { FakeIO } = require('./helpers/fakes');

function setup() {
  const io = new FakeIO();
  const clock = { t: 1000 };
  const m = new RoomManager({ io, now: () => clock.t, graceMs: 5000 });
  const sock = () => io.connect();
  return { io, m, clock, sock };
}

test('create room: unique short code, host in room, token is private to the creator', () => {
  const { m, sock } = setup();
  const a = sock();
  const r = m.createRoom(a, { nick: 'Alice' });
  assert.equal(r.ok, true);
  assert.match(r.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(r.you.token.length === 32 && r.you.id);
  const upd = a.last('room:update');
  assert.equal(upd.players.length, 1);
  assert.equal(upd.hostId, r.you.id);
  assert.ok(!JSON.stringify(upd).includes(r.you.token), 'tokens never appear in broadcasts');
});

test('join: validates code, rejects unknown room, rejects full room (5th player), no double joining', () => {
  const { m, sock } = setup();
  const host = sock();
  const { code } = m.createRoom(host, { nick: 'H' });
  assert.equal(m.joinRoom(sock(), { code: 'zz', nick: 'x' }).code, 'BAD_CODE');
  assert.equal(m.joinRoom(sock(), { code: 'ZZZZ', nick: 'x' }).code, 'NO_ROOM');
  assert.equal(m.joinRoom(sock(), null).code, 'BAD_REQUEST');
  const joined = [];
  for (let i = 0; i < 3; i++) { const s = sock(); const r = m.joinRoom(s, { code: code.toLowerCase(), nick: `P${i}` }); assert.equal(r.ok, true); joined.push(s); }
  const fifth = sock();
  const r5 = m.joinRoom(fifth, { code, nick: 'late' });
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'ROOM_FULL');
  assert.match(r5.error, /full/i);
  assert.equal(m.joinRoom(joined[0], { code, nick: 'again' }).code, 'ALREADY_IN_ROOM');
  assert.equal(m.createRoom(joined[0], {}).code, 'ALREADY_IN_ROOM');
  const colors = host.last('room:update').players.map((p) => p.color);
  assert.equal(new Set(colors).size, 4);
});

test('nickname and code sanitising', () => {
  assert.equal(sanitizeNick('  <b>Bob</b>  '), 'bBob/b'); // angle brackets stripped, whitespace trimmed
  assert.equal(sanitizeNick(''), 'Monkey');
  assert.equal(sanitizeNick(42), 'Monkey');
  assert.equal(sanitizeNick('x'.repeat(50)).length, 12);
  assert.equal(normalizeCode(' ab3k '), 'AB3K');
  assert.equal(normalizeCode('AB0K'), null);
  assert.equal(normalizeCode(1234), null);
});

test('ready and start: needs 2 players, host only, everyone ready', () => {
  const { m, sock } = setup();
  const h = sock(), g = sock();
  const { code } = m.createRoom(h, { nick: 'H' });
  assert.equal(m.startMatch(h).code, 'NEED_PLAYERS'); // cannot start alone
  m.joinRoom(g, { code, nick: 'G' });
  assert.equal(m.startMatch(g).code, 'NOT_HOST');
  assert.equal(m.startMatch(h).code, 'NOT_READY');
  m.setReady(g, true);
  assert.equal(h.last('room:update').players.find((p) => p.nick === 'G').ready, true);
  const r = m.startMatch(h);
  assert.equal(r.ok, true);
  const a = h.last('match:start'), b = g.last('match:start');
  assert.deepEqual(a, b, 'both players receive the identical match-start payload');
  assert.equal(a.players.length, 2);
  assert.equal(a.grid.length, C.COLS * C.ROWS);
  assert.equal(m.rooms.get(code).phase, 'countdown');
  assert.equal(m.joinRoom(sock(), { code, nick: 'x' }).code, 'IN_PROGRESS');
});

function startTwo(env) {
  const h = env.sock(), g = env.sock();
  const { code, you: hy } = env.m.createRoom(h, { nick: 'H' });
  const { you: gy } = env.m.joinRoom(g, { code, nick: 'G' });
  env.m.setReady(g, true);
  env.m.startMatch(h);
  return { h, g, code, hy, gy, room: env.m.rooms.get(code) };
}

test('tick drives countdown -> active; inputs are ignored during the countdown', () => {
  const env = setup();
  const { h, room } = startTwo(env);
  assert.equal(env.m.input(h, 1, 0), false);
  env.clock.t += C.COUNTDOWN_MS + 50;
  env.m.tick();
  assert.equal(room.phase, 'active');
  const snaps = h.all('game:snapshot');
  assert.ok(snaps.length >= 1);
  assert.equal(h.last('game:snapshot').ph, 'active');
  assert.equal(env.m.input(h, 1, 0), true);
});

test('bomb through manager, match end broadcast, rematch and back-to-lobby', () => {
  const env = setup();
  const { h, g, room } = startTwo(env);
  env.clock.t += C.COUNTDOWN_MS + 50; env.m.tick();
  assert.equal(env.m.bomb(h).ok, true);
  env.clock.t += 400; env.m.tick();
  env.clock.t += C.FUSE_MS; env.m.tick(); // H stands on its own bomb -> H dies, G wins
  env.clock.t += 40; env.m.tick();
  assert.equal(room.phase, 'ended');
  const end1 = h.last('match:end'), end2 = g.last('match:end');
  assert.deepEqual(end1, end2);
  assert.equal(end1.reason, 'last_standing');
  assert.equal(end1.standings[0].nick, 'G');
  assert.equal(env.m.rematch(g).code, 'NOT_HOST');
  assert.equal(env.m.rematch(h).ok, true);
  assert.equal(room.phase, 'countdown');
  assert.ok(h.all('match:start').length >= 2);
  // finish this match too, then return to lobby
  env.clock.t += C.COUNTDOWN_MS + 50; env.m.tick();
  env.m.bomb(g);
  env.clock.t += 400; env.m.tick();
  env.clock.t += C.FUSE_MS + 40; env.m.tick();
  assert.equal(room.phase, 'ended');
  assert.equal(env.m.backToLobby(h).ok, true);
  assert.equal(room.phase, 'lobby');
  assert.equal(h.last('room:update').phase, 'lobby');
});

test('leaving in lobby promotes a new host and empty rooms are deleted', () => {
  const { m, sock } = setup();
  const h = sock(), g = sock();
  const { code } = m.createRoom(h, { nick: 'H' });
  m.joinRoom(g, { code, nick: 'G' });
  m.leave(h);
  const upd = g.last('room:update');
  assert.equal(upd.players.length, 1);
  assert.equal(upd.hostId, upd.players[0].id);
  m.handleDisconnect(g);
  assert.equal(m.rooms.size, 0);
  assert.equal(m.stats().sockets, 0);
});

test('disconnect in a match: grace period, secure resume, expiry eliminates', () => {
  const env = setup();
  const { h, g, code, gy, room } = startTwo(env);
  env.clock.t += C.COUNTDOWN_MS + 50; env.m.tick();
  g.disconnect(); env.m.handleDisconnect(g);
  assert.equal(room.players.get(gy.id).connected, false);
  assert.equal(h.last('room:update').players.find((p) => p.id === gy.id).connected, false);
  // an impostor who guesses the id but not the token is refused
  const evil = env.sock();
  assert.equal(env.m.resume(evil, { code, pid: gy.id, token: 'f'.repeat(32) }).code, 'RESUME_FAILED');
  assert.equal(env.m.resume(evil, { code, pid: gy.id, token: 'short' }).code, 'RESUME_FAILED');
  assert.equal(env.m.resume(evil, { code, pid: 'nope', token: gy.token }).code, 'RESUME_FAILED');
  // the real player returns within grace
  env.clock.t += 2000; env.m.tick();
  const g2 = env.sock();
  const r = env.m.resume(g2, { code, pid: gy.id, token: gy.token });
  assert.equal(r.ok, true);
  assert.ok(g2.last('game:state'), 'receives full state on resume');
  assert.equal(room.players.get(gy.id).connected, true);
  assert.equal(room.game.players.get(gy.id).connected, true);
  // disconnect again and let grace expire
  g2.disconnect(); env.m.handleDisconnect(g2);
  env.clock.t += 5100; env.m.tick();
  env.clock.t += 40; env.m.tick();
  assert.equal(room.phase, 'ended');
  assert.equal(h.last('match:end').winnerId, room.hostId);
});

test('voluntary leave during a match eliminates immediately; host disconnect passes host role', () => {
  const env = setup();
  const { h, g, hy, gy, room } = startTwo(env);
  env.clock.t += C.COUNTDOWN_MS + 50; env.m.tick();
  h.disconnect(); env.m.handleDisconnect(h);
  assert.equal(room.hostId, gy.id, 'host moved to the connected player');
  env.m.leave(g);
  assert.equal(env.m.rooms.has(room.code), true); // H is still in grace
  env.clock.t += 6000; env.m.tick(); env.clock.t += 40; env.m.tick();
  assert.equal(env.m.rooms.size, 0, 'room cleaned up once nobody is left');
});

test('stale socket is replaced when the same player resumes', () => {
  const env = setup();
  const { h, code, hy } = startTwo(env);
  const h2 = env.sock();
  const r = env.m.resume(h2, { code, pid: hy.id, token: hy.token });
  assert.equal(r.ok, true);
  assert.equal(env.m.bySocket.get(h.id), undefined);
});

test('rate limiter refills over time', () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  for (let i = 0; i < 3; i++) assert.equal(rl.take('s', 'x', 1, 3), true);
  assert.equal(rl.take('s', 'x', 1, 3), false);
  t += 1100;
  assert.equal(rl.take('s', 'x', 1, 3), true);
  rl.drop('s');
  assert.equal(rl.take('s', 'x', 1, 3), true);
});

test('max rooms is enforced', () => {
  const io = new FakeIO();
  const m = new RoomManager({ io, maxRooms: 2 });
  assert.equal(m.createRoom(io.connect(), {}).ok, true);
  assert.equal(m.createRoom(io.connect(), {}).ok, true);
  assert.equal(m.createRoom(io.connect(), {}).code, 'SERVER_BUSY');
});
