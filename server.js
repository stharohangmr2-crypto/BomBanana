'use strict';
const path = require('path');
const http = require('http');
const C = require('./src/config');
const { RoomManager, RateLimiter } = require('./src/rooms');

/**
 * Builds the HTTP + Socket.IO server. `deps` exists so tests can inject in-memory fakes;
 * in production the real express / socket.io modules are loaded.
 */
function createServer(deps = {}, env = process.env) {
  const express = deps.express || require('express');
  const SocketIOServer = deps.SocketIOServer || require('socket.io').Server;
  const now = deps.now || (() => Date.now());

  const app = express();
  app.disable && app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const startedAt = Date.now();
  let manager = null;
  app.get('/health', (req, res) => {
    res.json({ ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), ...(manager ? manager.stats() : {}) });
  });

  const publicDir = path.join(__dirname, 'public');
  const threeDir = path.join(__dirname, 'node_modules', 'three', 'build');
  app.use('/vendor/three', express.static(threeDir, { maxAge: '7d' }));
  app.use(express.static(publicDir, { maxAge: 0, etag: true }));

  const server = http.createServer(app);
  const ioOptions = { maxHttpBufferSize: 1e4, pingInterval: 10000, pingTimeout: 8000 };
  if (env.ALLOWED_ORIGIN) ioOptions.cors = { origin: env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()) };
  const io = new SocketIOServer(server, ioOptions);

  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  manager = new RoomManager({
    io,
    now,
    maxRooms: Number(env.MAX_ROOMS) || 200,
    graceMs: Number(env.RECONNECT_GRACE_MS) || C.RECONNECT_GRACE_MS,
    log: deps.silent ? () => {} : log,
  });
  const limiter = new RateLimiter(now);

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const respond = (cb, payload) => { if (typeof cb === 'function') cb(payload); };
  const RATE_FAIL = { ok: false, code: 'RATE_LIMIT', error: 'Slow down a little.' };

  io.on('connection', (socket) => {
    // Each handler validates payload shape, rate-limits, then delegates. No client message can set
    // positions, damage, pickups or results: the server only accepts intent (move direction, bomb, ...).
    const guard = (name, perSec, burst) => limiter.take(socket.id, name, perSec, burst);

    socket.on('room:create', (data, cb) => {
      if (!guard('lobby', 1, 5)) return respond(cb, RATE_FAIL);
      respond(cb, manager.createRoom(socket, isObj(data) ? data : {}));
    });
    socket.on('room:join', (data, cb) => {
      if (!guard('lobby', 1, 5)) return respond(cb, RATE_FAIL);
      respond(cb, manager.joinRoom(socket, data));
    });
    socket.on('session:resume', (data, cb) => {
      if (!guard('lobby', 1, 5)) return respond(cb, RATE_FAIL);
      respond(cb, manager.resume(socket, data));
    });
    socket.on('room:ready', (data, cb) => {
      if (!guard('ui', 5, 10)) return respond(cb, RATE_FAIL);
      respond(cb, manager.setReady(socket, isObj(data) && data.ready === true));
    });
    socket.on('room:start', (data, cb) => {
      if (!guard('ui', 5, 10)) return respond(cb, RATE_FAIL);
      respond(cb, manager.startMatch(socket));
    });
    socket.on('room:rematch', (data, cb) => {
      if (!guard('ui', 5, 10)) return respond(cb, RATE_FAIL);
      respond(cb, manager.rematch(socket));
    });
    socket.on('room:lobby', (data, cb) => {
      if (!guard('ui', 5, 10)) return respond(cb, RATE_FAIL);
      respond(cb, manager.backToLobby(socket));
    });
    socket.on('room:leave', (data, cb) => {
      if (!guard('ui', 5, 10)) return respond(cb, RATE_FAIL);
      respond(cb, manager.leave(socket));
    });
    socket.on('state:request', (data, cb) => {
      if (!guard('state', 1, 3)) return respond(cb, RATE_FAIL);
      respond(cb, manager.requestState(socket));
    });
    socket.on('net:ping', (data, cb) => respond(cb, Date.now()));

    socket.on('game:input', (data) => {
      if (!guard('input', 60, 30) || !isObj(data)) return;
      manager.input(socket, data.dx, data.dy);
    });
    socket.on('game:bomb', () => { if (guard('act', 8, 8)) manager.bomb(socket); });
    socket.on('game:detonate', () => { if (guard('act', 8, 8)) manager.detonate(socket); });
    socket.on('game:trap', () => { if (guard('act', 8, 8)) manager.trap(socket); });

    socket.on('disconnect', () => {
      manager.handleDisconnect(socket);
      limiter.drop(socket.id);
    });
  });

  let timer = null;
  function start(port = Number(env.PORT) || 3000) {
    return new Promise((resolve) => {
      server.listen(port, '0.0.0.0', () => {
        timer = setInterval(() => manager.tick(), Math.round(1000 / C.TICK_HZ));
        resolve(server.address().port);
      });
    });
  }
  function stop() {
    if (timer) clearInterval(timer);
    return new Promise((resolve) => { io.close(() => resolve()); });
  }

  return { app, server, io, manager, start, stop };
}

module.exports = { createServer };

if (require.main === module) {
  const srv = createServer();
  srv.start().then((port) => {
    console.log(`Banana Blast 3D listening on port ${port}`);
    console.log('Open the public HTTPS URL of your host (not localhost) on every phone.');
  });
  const shutdown = () => { srv.stop().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
