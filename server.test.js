'use strict';
// Exercises server.js wiring (event names, validation, rate limits) against in-memory fakes of express and socket.io.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/config');
const { createServer } = require('../server');
const { FakeIO } = require('./helpers/fakes');

function fakeExpress() {
  const routes = {};
  const app = () => {};
  app.disable = () => {};
  app.use = () => {};
  app.get = (p, h) => { routes[p] = h; };
  const e = () => app;
  e.static = () => (req, res, next) => next && next();
  e.routes = routes;
  return e;
}

function boot() {
  const io = new FakeIO();
  const express = fakeExpress();
  class FakeServer { constructor() { return io; } }
  const clock = { t: 5000 };
  const srv = createServer({ express, SocketIOServer: FakeServer, now: () => clock.t, silent: true }, {});
  const connect = () => { const s = io.connect(); io.emit('connection', s); return s; };
  return { srv, io, connect, clock, express };
}

test('health endpoint reports ok', () => {
  const { express } = boot();
  let body = null;
  express.routes['/health']({}, { json: (b) => { body = b; } });
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeSec, 'number');
});

test('full flow through socket events: create, join, ready, start, play, finish', async () => {
  const { srv, connect, clock } = boot();
  const a = connect(), b = connect();
  const created = await a.call('room:create', { nick: 'Ann' });
  assert.equal(created.ok, true);
  const joined = await b.call('room:join', { code: created.code, nick: 'Bo' });
  assert.equal(joined.ok, true);
  assert.equal((await a.call('room:start', {})).code, 'NOT_READY');
  assert.equal((await b.call('room:ready', { ready: true })).ok, true);
  assert.equal((await a.call('room:start', {})).ok, true);
  assert.ok(a.last('match:start') && b.last('match:start'));
  clock.t += C.COUNTDOWN_MS + 10; srv.manager.tick();
  a.send('game:input', { dx: 1, dy: 0 });
  a.send('game:bomb');
  clock.t += 100; srv.manager.tick();
  const snap = a.last('game:snapshot');
  assert.equal(snap.b.length, 1);
  assert.equal(snap.p.length, 2);
  assert.equal(b.last('game:snapshot').b.length, 1, 'bomb is synchronised to the other client');
  clock.t += C.FUSE_MS + 50; srv.manager.tick(); clock.t += 40; srv.manager.tick();
  assert.ok(a.all('game:snapshot').some((s) => s.ev.some((e) => e.t === 'boom')));
});

test('malformed and hostile payloads never crash the server and cannot change state', async () => {
  const { srv, connect, clock } = boot();
  const a = connect(), b = connect();
  const { code } = await a.call('room:create', null);
  await b.call('room:join', { code, nick: 'B' });
  await b.call('room:ready', { ready: true });
  await a.call('room:start');
  clock.t += C.COUNTDOWN_MS + 10; srv.manager.tick();
  for (const bad of [null, undefined, 5, 'x', [], { dx: 'a', dy: {} }, { dx: Infinity, dy: NaN }, { __proto__: { dx: 1 } }]) a.send('game:input', bad);
  a.send('game:win', { winner: 'me' });
  a.send('game:damage', { target: 'x' });
  a.send('game:powerup', { type: 'bomb' });
  clock.t += 100; srv.manager.tick();
  const me = a.last('game:snapshot').p[0];
  assert.equal(me.mb, C.START_MAX_BOMBS);
  assert.equal((await a.call('room:join', 'garbage')).ok, false);
  assert.equal((await connect().call('room:join', { code: { $ne: 1 } })).code, 'BAD_CODE');
});

test('lobby events are rate limited', async () => {
  const { connect } = boot();
  const a = connect();
  let limited = 0;
  for (let i = 0; i < 12; i++) { const r = await a.call('room:join', { code: 'ABCD' }); if (r && r.code === 'RATE_LIMIT') limited++; }
  assert.ok(limited > 0);
});

test('five players: the fifth gets a clear error through the event layer', async () => {
  const { connect } = boot();
  const host = connect();
  const { code } = await host.call('room:create', { nick: 'h' });
  for (let i = 0; i < 3; i++) assert.equal((await connect().call('room:join', { code, nick: `p${i}` })).ok, true);
  const r = await connect().call('room:join', { code, nick: 'late' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROOM_FULL');
});

test('disconnect event cleans up lobby rooms', async () => {
  const { srv, connect } = boot();
  const a = connect();
  await a.call('room:create', { nick: 'a' });
  assert.equal(srv.manager.rooms.size, 1);
  a.disconnect();
  assert.equal(srv.manager.rooms.size, 0);
});

test('net:ping acks with a number', async () => {
  const { connect } = boot();
  assert.equal(typeof (await connect().call('net:ping')), 'number');
});
