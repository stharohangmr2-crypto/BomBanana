'use strict';
// In-memory stand-ins for socket.io (used because the real packages are not needed to test our own logic).
const { EventEmitter } = require('events');

class FakeSocket {
  constructor(io, id) {
    this.io = io; this.id = id; this.rooms = new Set();
    this.handlers = new Map(); this.received = []; // messages the server sent to this client
    this.connected = true;
  }
  on(ev, fn) { this.handlers.set(ev, fn); }
  emit(ev, payload) { this.received.push({ ev, payload }); }
  join(r) { this.rooms.add(r); }
  leave(r) { this.rooms.delete(r); }
  /** Simulate the client sending an event; resolves with the ack payload if the server acks. */
  call(ev, data) {
    return new Promise((resolve) => {
      const h = this.handlers.get(ev);
      if (!h) return resolve(undefined);
      let acked = false;
      h(data, (res) => { acked = true; resolve(res); });
      if (!acked) setImmediate(() => resolve(undefined));
    });
  }
  send(ev, data) { const h = this.handlers.get(ev); if (h) h(data, () => {}); }
  disconnect() { this.connected = false; const h = this.handlers.get('disconnect'); if (h) h(); this.io.sockets.delete(this.id); }
  last(ev) { for (let i = this.received.length - 1; i >= 0; i--) if (this.received[i].ev === ev) return this.received[i].payload; return undefined; }
  all(ev) { return this.received.filter((m) => m.ev === ev).map((m) => m.payload); }
}

class FakeIO extends EventEmitter {
  constructor() { super(); this.sockets = new Map(); this.n = 0; }
  to(room) {
    return { emit: (ev, payload) => { for (const s of this.sockets.values()) if (s.rooms.has(room)) s.emit(ev, JSON.parse(JSON.stringify(payload))); } };
  }
  connect() { const s = new FakeSocket(this, `s${++this.n}`); this.sockets.set(s.id, s); return s; }
  close(cb) { cb && cb(); }
}

module.exports = { FakeIO, FakeSocket };
