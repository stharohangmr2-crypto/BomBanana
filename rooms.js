'use strict';
/**
 * RoomManager owns rooms, players, the match lifecycle and reconnection.
 * It never imports socket.io: it only needs `io.to(room).emit(...)` and sockets that expose
 * `id`, `emit`, `join`, `leave`. That keeps it testable with in-memory fakes.
 *
 * DISCONNECT POLICY
 *  - lobby / results: the player is removed immediately (they can rejoin with the code).
 *  - countdown / active match: the player stays in the arena, standing still and vulnerable, for
 *    RECONNECT_GRACE_MS. They can resume with their private token. After the grace period they are
 *    eliminated. Leaving on purpose eliminates immediately.
 *  - host leaves/disconnects: host passes to the next connected player (earliest slot).
 *  - a room with no players is deleted.
 */
const crypto = require('crypto');
const C = require('./config');
const { Game } = require('./game');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const COLORS = ['#ffd43b', '#ff6b9d', '#38d9e8', '#7ae05a'];
const COLOR_NAMES = ['Yellow', 'Pink', 'Cyan', 'Green'];

const ERR = {
  BAD_REQUEST: 'Something was wrong with that request.',
  BAD_CODE: 'That room code is not valid. Room codes have 4 letters or numbers.',
  NO_ROOM: 'No room with that code. Check the code and try again.',
  ROOM_FULL: `That room is full (${C.MAX_PLAYERS}/${C.MAX_PLAYERS} players).`,
  IN_PROGRESS: 'A match is already running in that room. Try again when it finishes.',
  ALREADY_IN_ROOM: 'You are already in a room. Leave it first.',
  NOT_IN_ROOM: 'You are not in a room.',
  NOT_HOST: 'Only the host can do that.',
  NEED_PLAYERS: `At least ${C.MIN_PLAYERS} players are needed to start.`,
  NOT_READY: 'Everyone has to be ready first.',
  WRONG_PHASE: 'That is not possible right now.',
  SERVER_BUSY: 'The server is full right now. Please try again in a minute.',
  RESUME_FAILED: 'Could not rejoin that match.',
  RATE_LIMIT: 'Slow down a little.',
};

function fail(code) { return { ok: false, code, error: ERR[code] || ERR.BAD_REQUEST }; }

function sanitizeNick(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
  return s || 'Monkey';
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return /^[A-HJ-NP-Z2-9]{4}$/.test(c) ? c : null;
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Small token-bucket rate limiter keyed by (socket id, bucket name). */
class RateLimiter {
  constructor(now = () => Date.now()) { this.now = now; this.buckets = new Map(); }
  take(key, name, perSec, burst) {
    const k = `${key}:${name}`;
    const t = this.now();
    let b = this.buckets.get(k);
    if (!b) { b = { tokens: burst, at: t }; this.buckets.set(k, b); }
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  drop(key) { for (const k of this.buckets.keys()) if (k.startsWith(`${key}:`)) this.buckets.delete(k); }
}

class RoomManager {
  constructor({ io, now = () => Date.now(), maxRooms = 200, graceMs = C.RECONNECT_GRACE_MS, log = () => {} }) {
    this.io = io;
    this.now = now;
    this.maxRooms = maxRooms;
    this.graceMs = graceMs;
    this.log = log;
    this.rooms = new Map(); // code -> room
    this.bySocket = new Map(); // socket.id -> { code, pid }
    this.socketRefs = new Map(); // socket.id -> socket
  }

  // ------------------------------------------------------------ helpers

  _newCode() {
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let j = 0; j < 4; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    return null;
  }

  _ctx(socket) {
    const m = this.bySocket.get(socket.id);
    if (!m) return null;
    const room = this.rooms.get(m.code);
    const player = room && room.players.get(m.pid);
    if (!room || !player) return null;
    return { room, player };
  }

  _publicRoom(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      max: C.MAX_PLAYERS,
      players: [...room.players.values()].sort((a, b) => a.slot - b.slot).map((p) => ({
        id: p.id, nick: p.nick, color: p.color, colorName: COLOR_NAMES[p.slot], slot: p.slot,
        ready: p.ready || p.id === room.hostId, connected: p.connected,
      })),
    };
  }

  _broadcastRoom(room) { this.io.to(room.code).emit('room:update', this._publicRoom(room)); }

  _attach(socket, room, player) {
    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAt = 0;
    this.bySocket.set(socket.id, { code: room.code, pid: player.id });
    this.socketRefs.set(socket.id, socket);
    socket.join(room.code);
  }

  _detach(socket, room) {
    this.bySocket.delete(socket.id);
    this.socketRefs.delete(socket.id);
    if (socket.leave) socket.leave(room.code);
  }

  _freeSlot(room) {
    const used = new Set([...room.players.values()].map((p) => p.slot));
    for (let i = 0; i < C.MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return -1;
  }

  _reassignHost(room) {
    const cur = room.players.get(room.hostId);
    if (cur && cur.connected) return;
    const next = [...room.players.values()].filter((p) => p.connected).sort((a, b) => a.slot - b.slot)[0]
      || [...room.players.values()].sort((a, b) => a.slot - b.slot)[0];
    room.hostId = next ? next.id : null;
  }

  _deleteIfEmpty(room) {
    if (room.players.size === 0) { this.rooms.delete(room.code); this.log(`room ${room.code} closed (empty)`); return true; }
    return false;
  }

  _addPlayer(socket, room, nick) {
    const slot = this._freeSlot(room);
    const player = {
      id: crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      nick: sanitizeNick(nick), slot, color: COLORS[slot],
      ready: false, connected: true, socketId: null, disconnectedAt: 0,
    };
    room.players.set(player.id, player);
    this._attach(socket, room, player);
    return player;
  }

  // ------------------------------------------------------------ lobby API

  createRoom(socket, data) {
    if (this.bySocket.has(socket.id)) return fail('ALREADY_IN_ROOM');
    if (this.rooms.size >= this.maxRooms) return fail('SERVER_BUSY');
    const code = this._newCode();
    if (!code) return fail('SERVER_BUSY');
    const room = { code, hostId: null, phase: 'lobby', players: new Map(), game: null, createdAt: this.now() };
    this.rooms.set(code, room);
    const player = this._addPlayer(socket, room, data && data.nick);
    room.hostId = player.id;
    this._broadcastRoom(room);
    this.log(`room ${code} created`);
    return { ok: true, code, you: { id: player.id, token: player.token }, room: this._publicRoom(room) };
  }

  joinRoom(socket, data) {
    if (!data || typeof data !== 'object') return fail('BAD_REQUEST');
    if (this.bySocket.has(socket.id)) return fail('ALREADY_IN_ROOM');
    const code = normalizeCode(data.code);
    if (!code) return fail('BAD_CODE');
    const room = this.rooms.get(code);
    if (!room) return fail('NO_ROOM');
    if (room.phase !== 'lobby') return fail('IN_PROGRESS');
    if (room.players.size >= C.MAX_PLAYERS) return fail('ROOM_FULL');
    const player = this._addPlayer(socket, room, data.nick);
    this._broadcastRoom(room);
    return { ok: true, code, you: { id: player.id, token: player.token }, room: this._publicRoom(room) };
  }

  setReady(socket, ready) {
    const ctx = this._ctx(socket);
    if (!ctx) return fail('NOT_IN_ROOM');
    if (ctx.room.phase !== 'lobby') return fail('WRONG_PHASE');
    ctx.player.ready = !!ready;
    this._broadcastRoom(ctx.room);
    return { ok: true };
  }

  startMatch(socket) {
    const ctx = this._ctx(socket);
    if (!ctx) return fail('NOT_IN_ROOM');
    const { room, player } = ctx;
    if (room.hostId !== player.id) return fail('NOT_HOST');
    if (room.phase !== 'lobby') return fail('WRONG_PHASE');
    const players = [...room.players.values()].filter((p) => p.connected);
    if (players.length < C.MIN_PLAYERS) return fail('NEED_PLAYERS');
    if (players.some((p) => p.id !== room.hostId && !p.ready)) return fail('NOT_READY');
    this._beginMatch(room);
    return { ok: true };
  }

  rematch(socket) {
    const ctx = this._ctx(socket);
    if (!ctx) return fail('NOT_IN_ROOM');
    const { room, player } = ctx;
    if (room.hostId !== player.id) return fail('NOT_HOST');
    if (room.phase !== 'ended') return fail('WRONG_PHASE');
    if (room.players.size < C.MIN_PLAYERS) return fail('NEED_PLAYERS');
    this._beginMatch(room);
    return { ok: true };
  }

  backToLobby(socket) {
    const ctx = this._ctx(socket);
    if (!ctx) return fail('NOT_IN_ROOM');
    const { room, player } = ctx;
    if (room.hostId !== player.id) return fail('NOT_HOST');
    if (room.phase !== 'ended') return fail('WRONG_PHASE');
    room.phase = 'lobby';
    room.game = null;
    for (const p of room.players.values()) p.ready = false;
    this._broadcastRoom(room);
    return { ok: true };
  }

  leave(socket) {
    const ctx = this._ctx(socket);
    if (!ctx) { this.bySocket.delete(socket.id); return { ok: true }; }
    const { room, player } = ctx;
    this._detach(socket, room);
    const inMatch = room.phase === 'countdown' || room.phase === 'active';
    if (inMatch && room.game) room.game.eliminateByDisconnect(player.id, this.now(), 'left');
    room.players.delete(player.id);
    this._afterMembershipChange(room);
    return { ok: true };
  }

  handleDisconnect(socket) {
    const ctx = this._ctx(socket);
    this.socketRefs.delete(socket.id);
    if (!ctx) { this.bySocket.delete(socket.id); return; }
    const { room, player } = ctx;
    this.bySocket.delete(socket.id);
    const inMatch = room.phase === 'countdown' || room.phase === 'active';
    if (inMatch) {
      player.connected = false;
      player.disconnectedAt = this.now();
      player.socketId = null;
      if (room.game) room.game.setConnected(player.id, false);
      this._reassignHost(room);
      this._broadcastRoom(room);
      this.log(`player ${player.id} disconnected from ${room.code}; grace ${this.graceMs}ms`);
    } else {
      room.players.delete(player.id);
      this._afterMembershipChange(room);
    }
  }

  _afterMembershipChange(room) {
    if (this._deleteIfEmpty(room)) return;
    this._reassignHost(room);
    this._broadcastRoom(room);
  }

  resume(socket, data) {
    if (!data || typeof data !== 'object') return fail('BAD_REQUEST');
    if (this.bySocket.has(socket.id)) return fail('ALREADY_IN_ROOM');
    const code = normalizeCode(data.code);
    const room = code && this.rooms.get(code);
    const player = room && typeof data.pid === 'string' ? room.players.get(data.pid) : null;
    if (!player || !safeEqualHex(player.token, data.token)) return fail('RESUME_FAILED');
    const inMatch = room.phase === 'countdown' || room.phase === 'active';
    if (!inMatch && room.phase !== 'lobby' && room.phase !== 'ended') return fail('RESUME_FAILED');
    // Take over from a stale socket if the old connection has not timed out yet.
    if (player.socketId && player.socketId !== socket.id) {
      const old = this.socketRefs.get(player.socketId);
      this.bySocket.delete(player.socketId);
      this.socketRefs.delete(player.socketId);
      if (old) { try { old.leave(room.code); old.emit('session:replaced'); } catch (e) { /* ignore */ } }
    }
    this._attach(socket, room, player);
    if (room.game) room.game.setConnected(player.id, true);
    this._reassignHost(room);
    this._broadcastRoom(room);
    if (inMatch && room.game) socket.emit('game:state', room.game.fullState(this.now()));
    if (room.phase === 'ended' && room.game && room.game.result) socket.emit('match:end', room.game.result);
    return { ok: true, code: room.code, you: { id: player.id, token: player.token }, room: this._publicRoom(room) };
  }

  // ------------------------------------------------------------ match lifecycle

  _beginMatch(room) {
    const now = this.now();
    const players = [...room.players.values()].sort((a, b) => a.slot - b.slot);
    room.game = new Game({
      seed: crypto.randomInt(1, 2 ** 31 - 1),
      players: players.map((p) => ({ id: p.id, nick: p.nick, color: p.color, slot: p.slot })),
      startAt: now + C.COUNTDOWN_MS,
    });
    room.phase = 'countdown';
    for (const p of players) { p.ready = false; if (!p.connected) room.game.setConnected(p.id, false); }
    this._broadcastRoom(room);
    // Same payload, same event, for every connected player.
    this.io.to(room.code).emit('match:start', room.game.fullState(now));
    this.log(`match started in ${room.code} with ${players.length} players`);
  }

  requestState(socket) {
    const ctx = this._ctx(socket);
    if (!ctx || !ctx.room.game) return fail('WRONG_PHASE');
    if (ctx.room.phase === 'countdown' || ctx.room.phase === 'active') {
      socket.emit('game:state', ctx.room.game.fullState(this.now()));
    }
    return { ok: true };
  }

  _gameCtx(socket) {
    const ctx = this._ctx(socket);
    if (!ctx || !ctx.room.game || ctx.room.phase !== 'active') return null;
    return ctx;
  }

  input(socket, dx, dy) {
    const ctx = this._gameCtx(socket);
    if (!ctx) return false;
    return ctx.room.game.setInput(ctx.player.id, dx, dy, this.now());
  }

  bomb(socket) { const c = this._gameCtx(socket); return c ? c.room.game.placeBomb(c.player.id, this.now()) : fail('WRONG_PHASE'); }
  detonate(socket) { const c = this._gameCtx(socket); return c ? c.room.game.detonate(c.player.id, this.now()) : fail('WRONG_PHASE'); }
  trap(socket) { const c = this._gameCtx(socket); return c ? c.room.game.placeTrap(c.player.id, this.now()) : fail('WRONG_PHASE'); }

  /** Advance every room. Called ~30 times per second by the server (or manually in tests). */
  tick(now = this.now()) {
    for (const room of [...this.rooms.values()]) {
      if (!room.game) continue;
      if (room.phase === 'countdown' || room.phase === 'active') {
        // Disconnect grace expiry
        for (const p of room.players.values()) {
          if (!p.connected && p.disconnectedAt && now - p.disconnectedAt >= this.graceMs) {
            room.game.eliminateByDisconnect(p.id, now, 'disconnect');
            p.disconnectedAt = 0;
          }
        }
        room.game.update(now);
        const snap = room.game.snapshot(now);
        snap.ev = room.game.drainEvents();
        this.io.to(room.code).emit('game:snapshot', snap);
        if (room.phase === 'countdown' && room.game.phase !== 'countdown') room.phase = 'active';
        if (room.game.phase === 'over') this._finishMatch(room);
      }
    }
  }

  _finishMatch(room) {
    room.phase = 'ended';
    for (const p of [...room.players.values()]) {
      p.ready = false;
      if (!p.connected) room.players.delete(p.id); // nobody to wait for
    }
    this.io.to(room.code).emit('match:end', room.game.result);
    this.log(`match ended in ${room.code}: ${room.game.result.reason}`);
    if (this._deleteIfEmpty(room)) return;
    this._reassignHost(room);
    this._broadcastRoom(room);
  }

  stats() { return { rooms: this.rooms.size, sockets: this.bySocket.size }; }
}

module.exports = { RoomManager, RateLimiter, sanitizeNick, normalizeCode, COLORS, ERR, CODE_ALPHABET };
