'use strict';
/**
 * Authoritative match simulation. Pure logic: no sockets, no timers, no I/O.
 * The caller passes `now` (ms) into every call, which makes the simulation deterministic and testable.
 *
 * ORDER OF OPERATIONS inside update(now) (documented contract):
 *   1. expire banana traps
 *   2. move every living player (axis-separated collision, kicks, wall/crate/bomb blocking)
 *   3. release "walk-through" rights of bombs a player has stepped off
 *   4. power-up pickups, then banana-trap triggers
 *   5. detonations: every bomb whose fuse expired (or was remotely triggered) is collected, chain
 *      reactions are expanded to a fixed point, ALL blast shapes are computed against the crate/wall
 *      layout as it was at the start of this step, then bombs are removed, crates destroyed,
 *      old pickups/traps in the blast destroyed, drops rolled, and ONE flame group (gid) is created.
 *   6. flame damage: each living player standing in a flame cell is hit at most once per gid;
 *      a shield absorbs the hit, otherwise the player is eliminated. All eliminations of one update
 *      share the same timestamp, so simultaneous deaths are detected as draws.
 *   7. win / draw / time-up check
 * Because blast shapes use the pre-step layout and results are unions, the outcome does not depend on
 * the order in which simultaneous bombs are processed.
 */
const C = require('./config');

const { COLS, ROWS } = C;
const FLOOR = 0;
const WALL = 1;
const CRATE = 2;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const POWERUP_TYPES = Object.keys(C.DROP_WEIGHTS);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idx = (x, y) => y * COLS + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const round3 = (n) => Math.round(n * 1000) / 1000;

const SPAWNS = [
  [1, 1],
  [COLS - 2, 1],
  [1, ROWS - 2],
  [COLS - 2, ROWS - 2],
];

/** Cells that must stay free of crates around a spawn (an L shape plus two escape cells). */
function spawnSafeCells(slot) {
  const [sx, sy] = SPAWNS[slot];
  const dx = sx < COLS / 2 ? 1 : -1;
  const dy = sy < ROWS / 2 ? 1 : -1;
  return [
    [sx, sy],
    [sx + dx, sy],
    [sx + 2 * dx, sy],
    [sx, sy + dy],
    [sx, sy + 2 * dy],
    [sx + 2 * dx, sy + dy],
    [sx + dx, sy + 2 * dy],
  ];
}

function generateGrid(seed) {
  const rng = mulberry32(seed);
  const grid = new Uint8Array(COLS * ROWS);
  const safe = new Set();
  for (let s = 0; s < 4; s++) for (const [x, y] of spawnSafeCells(s)) safe.add(idx(x, y));
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const border = x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1;
      const pillar = x % 2 === 0 && y % 2 === 0;
      if (border || pillar) grid[idx(x, y)] = WALL;
      else if (!safe.has(idx(x, y)) && rng() < C.CRATE_DENSITY) grid[idx(x, y)] = CRATE;
      else grid[idx(x, y)] = FLOOR;
    }
  }
  return grid;
}

class Game {
  /**
   * @param {{seed:number, players:{id:string,nick:string,color:string,slot:number}[], startAt:number}} opts
   */
  constructor({ seed, players, startAt }) {
    this.seed = seed >>> 0;
    this.rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0); // separate stream for drops
    this.grid = generateGrid(this.seed);
    this.crateCount = 0;
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === CRATE) this.crateCount++;

    this.phase = 'countdown'; // countdown -> active -> over
    this.startAt = startAt;
    this.endsAt = 0;
    this.lastUpdate = startAt;
    this.events = [];
    this.result = null;

    this.bombs = new Map(); // id -> bomb
    this.bombCells = new Map(); // cell index -> bomb
    this.powerups = new Map(); // id -> {id,x,y,type}
    this.traps = new Map(); // id -> trap
    this.flames = []; // {gid, cells: Map(cellIndex -> ownerId), until}
    this.seq = { bomb: 0, up: 0, trap: 0, gid: 0 };

    this.players = new Map();
    for (const p of players) {
      const [sx, sy] = SPAWNS[p.slot];
      this.players.set(p.id, {
        id: p.id, nick: p.nick, color: p.color, slot: p.slot,
        x: sx + 0.5, y: sy + 0.5, fx: 0, fy: 1,
        alive: true, connected: true,
        dirX: 0, dirY: 0, lastInputAt: 0, moving: false,
        maxBombs: C.START_MAX_BOMBS, range: C.START_RANGE,
        speedUntil: 0, shield: false, invulnUntil: 0,
        det: 0, traps: 0, kick: false,
        lastBombAt: -1e9, slipUntil: 0, slipDx: 0, slipDy: 0,
        hitGids: new Set(),
        elimAt: 0, elimBy: null, elimReason: null,
        kills: 0, selfKo: 0,
      });
    }
  }

  // ---------------------------------------------------------------- public API (called by RoomManager)

  config() {
    return {
      cols: COLS, rows: ROWS, fuseMs: C.FUSE_MS, flameMs: C.FLAME_MS, matchMs: C.MATCH_MS,
      baseSpeed: C.BASE_SPEED, speedMs: C.SPEED_MS,
    };
  }

  setInput(pid, dx, dy, now) {
    const p = this.players.get(pid);
    if (!p || !p.alive || this.phase !== 'active') return false;
    if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    let len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; len = 1; }
    if (len < 0.05) { dx = 0; dy = 0; }
    p.dirX = dx; p.dirY = dy; p.lastInputAt = now;
    if (len > 0) { const l = Math.hypot(dx, dy); p.fx = dx / l; p.fy = dy / l; }
    return true;
  }

  placeBomb(pid, now) {
    const p = this.players.get(pid);
    if (!p || !p.alive) return { ok: false, reason: 'dead' };
    if (this.phase !== 'active') return { ok: false, reason: 'not_active' };
    if (now - p.lastBombAt < C.BOMB_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
    let mine = 0;
    for (const b of this.bombs.values()) if (b.owner === pid) mine++;
    if (mine >= p.maxBombs) return { ok: false, reason: 'capacity' };
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    if (!inBounds(cx, cy) || this.grid[idx(cx, cy)] !== FLOOR) return { ok: false, reason: 'blocked' };
    if (this.bombCells.has(idx(cx, cy))) return { ok: false, reason: 'occupied' };
    if (this._inFlame(idx(cx, cy), now)) return { ok: false, reason: 'flame' };
    const bomb = {
      id: ++this.seq.bomb, owner: pid, cx, cy, range: p.range,
      placedAt: now, explodeAt: now + C.FUSE_MS, pass: new Set(), kickedAt: -1e9,
    };
    for (const q of this.players.values()) if (q.alive && this._overlapsCell(q, cx, cy)) bomb.pass.add(q.id);
    this.bombs.set(bomb.id, bomb);
    this.bombCells.set(idx(cx, cy), bomb);
    p.lastBombAt = now;
    this.events.push({ t: 'bomb', id: bomb.id, x: cx, y: cy, o: pid });
    return { ok: true, id: bomb.id };
  }

  detonate(pid, now) {
    const p = this.players.get(pid);
    if (!p || !p.alive || this.phase !== 'active') return { ok: false, reason: 'not_active' };
    if (p.det <= 0) return { ok: false, reason: 'no_detonator' };
    let target = null;
    for (const b of this.bombs.values()) {
      if (b.owner !== pid || now - b.placedAt < C.REMOTE_MIN_FUSE_AGE_MS || b.explodeAt <= now) continue;
      if (!target || b.placedAt < target.placedAt) target = b;
    }
    if (!target) return { ok: false, reason: 'no_bomb' };
    p.det--;
    target.explodeAt = now;
    return { ok: true, id: target.id };
  }

  placeTrap(pid, now) {
    const p = this.players.get(pid);
    if (!p || !p.alive || this.phase !== 'active') return { ok: false, reason: 'not_active' };
    if (p.traps <= 0) return { ok: false, reason: 'no_trap' };
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    if (!inBounds(cx, cy) || this.grid[idx(cx, cy)] !== FLOOR) return { ok: false, reason: 'blocked' };
    for (const t of this.traps.values()) if (t.x === cx && t.y === cy) return { ok: false, reason: 'occupied' };
    p.traps--;
    const trap = { id: ++this.seq.trap, x: cx, y: cy, owner: pid, armAt: now + C.TRAP_ARM_MS, expiresAt: now + C.TRAP_MS };
    this.traps.set(trap.id, trap);
    this.events.push({ t: 'trap', id: trap.id, x: cx, y: cy, o: pid });
    return { ok: true, id: trap.id };
  }

  setConnected(pid, connected) {
    const p = this.players.get(pid);
    if (!p) return;
    p.connected = connected;
    if (!connected) { p.dirX = 0; p.dirY = 0; }
  }

  /** Removes a player from the fight because they left or stayed disconnected past the grace period. */
  eliminateByDisconnect(pid, now, reason) {
    const p = this.players.get(pid);
    if (!p || !p.alive) return;
    this._eliminate(p, null, now, reason || 'disconnect');
    if (this.phase === 'active') this._checkEnd(now);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------------------------------------------------------------- simulation

  update(now) {
    if (this.phase === 'over') return;
    if (this.phase === 'countdown') {
      if (now < this.startAt) return;
      this.phase = 'active';
      this.endsAt = this.startAt + C.MATCH_MS;
      this.lastUpdate = now;
    }
    const dt = Math.min(Math.max((now - this.lastUpdate) / 1000, 0), 0.1);
    this.lastUpdate = now;
    this._now = now;

    for (const [id, t] of this.traps) if (t.expiresAt <= now) this.traps.delete(id);

    for (const p of this.players.values()) if (p.alive) this._move(p, dt, now);
    this._updatePassRights();

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      this._pickup(p, now);
      this._trapCheck(p, now);
    }

    this._detonations(now);
    this._flameDamage(now);
    this._checkEnd(now);
  }

  _eliminate(p, by, now, reason) {
    p.alive = false;
    p.elimAt = now;
    p.elimBy = by;
    p.elimReason = reason;
    p.dirX = 0; p.dirY = 0;
    if (by && by !== p.id) { const k = this.players.get(by); if (k) k.kills++; }
    else if (by === p.id) p.selfKo++;
    this.events.push({ t: 'elim', id: p.id, by: by || null, r: reason });
  }

  _overlapsCell(p, cx, cy) {
    return p.x + C.HALF > cx && p.x - C.HALF < cx + 1 && p.y + C.HALF > cy && p.y - C.HALF < cy + 1;
  }

  _blocked(px, py, p) {
    const h = C.HALF;
    const x0 = Math.floor(px - h), x1 = Math.floor(px + h - 1e-9);
    const y0 = Math.floor(py - h), y1 = Math.floor(py + h - 1e-9);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inBounds(x, y)) return true;
        if (this.grid[idx(x, y)] !== FLOOR) return true;
        const b = this.bombCells.get(idx(x, y));
        if (b && !b.pass.has(p.id)) return true;
      }
    }
    return false;
  }

  _move(p, dt, now) {
    let dx = p.dirX, dy = p.dirY;
    if (now - p.lastInputAt > C.INPUT_TIMEOUT_MS || !p.connected) { dx = 0; dy = 0; }
    const slipping = now < p.slipUntil;
    if (slipping) { dx = p.slipDx; dy = p.slipDy; }
    if (dx === 0 && dy === 0) { p.moving = false; return; }
    const speed = C.BASE_SPEED * (now < p.speedUntil ? C.SPEED_MULT : 1) * (slipping ? C.SLIP_MULT : 1);
    const dist = speed * dt;
    const steps = Math.max(1, Math.ceil(dist / 0.15));
    const sd = dist / steps;
    for (let i = 0; i < steps; i++) this._step(p, dx * sd, dy * sd, now);
    p.moving = true;
  }

  _step(p, mx, my, now) {
    if (mx !== 0) {
      const nx = p.x + mx;
      if (!this._blocked(nx, p.y, p)) p.x = nx;
      else {
        if (p.kick) this._tryKick(p, Math.sign(mx), 0, now, nx, p.y);
        if (my === 0) this._assist(p, 'y', Math.abs(mx));
      }
    }
    if (my !== 0) {
      const ny = p.y + my;
      if (!this._blocked(p.x, ny, p)) p.y = ny;
      else {
        if (p.kick) this._tryKick(p, 0, Math.sign(my), now, p.x, ny);
        if (mx === 0) this._assist(p, 'x', Math.abs(my));
      }
    }
  }

  /** Corner assist: nudge the player toward the centre line of their current row/column so they can slide past corners. */
  _assist(p, axis, amount) {
    const cur = axis === 'y' ? p.y : p.x;
    const center = Math.floor(cur) + 0.5;
    const d = center - cur;
    if (Math.abs(d) < 1e-3) return;
    const next = cur + Math.sign(d) * Math.min(Math.abs(d), amount);
    if (axis === 'y' ? !this._blocked(p.x, next, p) : !this._blocked(next, p.y, p)) {
      if (axis === 'y') p.y = next; else p.x = next;
    }
  }

  _tryKick(p, sx, sy, now, nx, ny) {
    // Cell containing the leading edge of the position the player tried to move to.
    const lx = nx + sx * C.HALF, ly = ny + sy * C.HALF;
    const ix = sx > 0 ? Math.floor(lx - 1e-9) : Math.floor(lx);
    const iy = sy > 0 ? Math.floor(ly - 1e-9) : Math.floor(ly);
    const bomb = inBounds(ix, iy) ? this.bombCells.get(idx(ix, iy)) : null;
    if (!bomb || bomb.pass.has(p.id) || now - bomb.kickedAt < C.KICK_COOLDOWN_MS) return;
    // The player must be roughly lined up with the bomb.
    const off = sx !== 0 ? Math.abs(p.y - (iy + 0.5)) : Math.abs(p.x - (ix + 0.5));
    if (off > 0.35) return;
    const tx = ix + sx, ty = iy + sy;
    if (!inBounds(tx, ty) || this.grid[idx(tx, ty)] !== FLOOR || this.bombCells.has(idx(tx, ty))) return;
    for (const q of this.players.values()) if (q.alive && this._overlapsCell(q, tx, ty)) return;
    this.bombCells.delete(idx(bomb.cx, bomb.cy));
    bomb.cx = tx; bomb.cy = ty; bomb.kickedAt = now;
    this.bombCells.set(idx(tx, ty), bomb);
    this.events.push({ t: 'kick', id: bomb.id, x: tx, y: ty });
  }

  _updatePassRights() {
    for (const b of this.bombs.values()) {
      if (b.pass.size === 0) continue;
      for (const pid of b.pass) {
        const p = this.players.get(pid);
        if (!p || !p.alive || !this._overlapsCell(p, b.cx, b.cy)) b.pass.delete(pid);
      }
    }
  }

  _pickup(p, now) {
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    for (const u of this.powerups.values()) {
      if (u.x !== cx || u.y !== cy) continue;
      this.powerups.delete(u.id); // removed first, so it can never be collected twice
      switch (u.type) {
        case 'bomb': p.maxBombs = Math.min(C.CAP_MAX_BOMBS, p.maxBombs + 1); break;
        case 'range': p.range = Math.min(C.CAP_RANGE, p.range + 1); break;
        case 'speed': p.speedUntil = Math.max(p.speedUntil, now) + C.SPEED_MS; break;
        case 'shield': p.shield = true; break;
        case 'detonator': p.det += C.DET_CHARGES; break;
        case 'banana': p.traps = Math.min(C.CAP_TRAPS, p.traps + 1); break;
        case 'kick': p.kick = true; break;
        default: break;
      }
      this.events.push({ t: 'pickup', id: u.id, p: p.id, k: u.type, x: u.x, y: u.y });
      break; // one pickup per tick per player
    }
  }

  _trapCheck(p, now) {
    if (now < p.slipUntil) return;
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    for (const t of this.traps.values()) {
      if (t.x !== cx || t.y !== cy) continue;
      if (t.owner === p.id && now < t.armAt) continue;
      this.traps.delete(t.id);
      let dx = p.dirX, dy = p.dirY;
      if (dx === 0 && dy === 0) { dx = p.fx; dy = p.fy; }
      const l = Math.hypot(dx, dy) || 1;
      p.slipDx = dx / l; p.slipDy = dy / l; p.slipUntil = now + C.SLIP_MS;
      this.events.push({ t: 'slip', id: p.id, trap: t.id });
      break;
    }
  }

  _inFlame(cell, now) {
    for (const f of this.flames) if (f.until > now && f.cells.has(cell)) return true;
    return false;
  }

  _detonations(now) {
    const due = [];
    for (const b of this.bombs.values()) if (b.explodeAt <= now) due.push(b);
    if (due.length === 0) return;
    due.sort((a, b) => a.explodeAt - b.explodeAt || a.id - b.id);

    const gid = ++this.seq.gid;
    const queue = due.slice();
    const done = new Map();
    const cells = new Map(); // cell index -> owner id (first bomb to reach it, in processing order)
    const origins = [];
    while (queue.length) {
      const b = queue.shift();
      if (done.has(b.id)) continue;
      done.set(b.id, b);
      origins.push([b.cx, b.cy]);
      const add = (x, y) => { const k = idx(x, y); if (!cells.has(k)) cells.set(k, b.owner); };
      add(b.cx, b.cy);
      for (const [dx, dy] of DIRS) {
        for (let i = 1; i <= b.range; i++) {
          const x = b.cx + dx * i, y = b.cy + dy * i;
          if (!inBounds(x, y)) break;
          const t = this.grid[idx(x, y)]; // pre-step layout: crates still block every blast in this step
          if (t === WALL) break;
          add(x, y);
          if (t === CRATE) break;
          const other = this.bombCells.get(idx(x, y));
          if (other) { if (!done.has(other.id)) queue.push(other); break; } // chain reaction
        }
      }
    }

    for (const b of done.values()) { this.bombs.delete(b.id); this.bombCells.delete(idx(b.cx, b.cy)); }

    const destroyed = [];
    for (const k of cells.keys()) {
      if (this.grid[k] === CRATE) { this.grid[k] = FLOOR; this.crateCount--; destroyed.push(k); }
    }
    for (const [id, u] of this.powerups) if (cells.has(idx(u.x, u.y))) { this.powerups.delete(id); this.events.push({ t: 'upgone', id }); }
    for (const [id, t] of this.traps) if (cells.has(idx(t.x, t.y))) this.traps.delete(id);

    for (const k of destroyed) {
      const x = k % COLS, y = Math.floor(k / COLS);
      this.events.push({ t: 'crate', x, y });
      if (this.rng() < C.DROP_CHANCE) {
        const type = this._rollDrop();
        const u = { id: ++this.seq.up, x, y, type };
        this.powerups.set(u.id, u);
        this.events.push({ t: 'drop', id: u.id, x, y, k: type });
      }
    }

    this.flames.push({ gid, cells, until: now + C.FLAME_MS });
    this.events.push({
      t: 'boom', gid, ms: C.FLAME_MS, origins,
      cells: Array.from(cells.keys()).map((k) => [k % COLS, Math.floor(k / COLS)]),
    });
  }

  _rollDrop() {
    let total = 0;
    for (const t of POWERUP_TYPES) total += C.DROP_WEIGHTS[t];
    let r = this.rng() * total;
    for (const t of POWERUP_TYPES) { r -= C.DROP_WEIGHTS[t]; if (r < 0) return t; }
    return POWERUP_TYPES[0];
  }

  _flameDamage(now) {
    this.flames = this.flames.filter((f) => f.until > now);
    for (const f of this.flames) {
      for (const p of this.players.values()) {
        if (!p.alive || p.hitGids.has(f.gid)) continue;
        const k = idx(Math.floor(p.x), Math.floor(p.y));
        if (!f.cells.has(k)) continue;
        p.hitGids.add(f.gid); // at most one hit per explosion group, whatever the number of overlapping cells/bombs
        if (now < p.invulnUntil) continue;
        if (p.shield) {
          p.shield = false;
          p.invulnUntil = now + C.SHIELD_INVULN_MS;
          this.events.push({ t: 'shield', id: p.id });
        } else {
          this._eliminate(p, f.cells.get(k), now, 'blast');
        }
      }
    }
  }

  _checkEnd(now) {
    if (this.phase !== 'active') return;
    const alive = [...this.players.values()].filter((p) => p.alive);
    let reason = null;
    let winnerId = null;
    let drawIds = [];
    if (alive.length === 0) {
      reason = 'all_eliminated';
      let last = -1;
      for (const p of this.players.values()) last = Math.max(last, p.elimAt);
      drawIds = [...this.players.values()].filter((p) => p.elimAt === last).map((p) => p.id);
    } else if (alive.length === 1) {
      reason = 'last_standing';
      winnerId = alive[0].id;
    } else if (now >= this.endsAt) {
      reason = 'time_up';
      drawIds = alive.map((p) => p.id);
    }
    if (!reason) return;
    this.phase = 'over';
    this.result = this._buildResult(reason, winnerId, drawIds, now);
  }

  _buildResult(reason, winnerId, drawIds, now) {
    const list = [...this.players.values()].sort((a, b) => (b.alive - a.alive) || (b.elimAt - a.elimAt) || (a.slot - b.slot));
    const standings = [];
    let rank = 0;
    let prev = null;
    list.forEach((p, i) => {
      const key = `${p.alive ? 1 : 0}:${p.alive ? 0 : p.elimAt}`;
      if (key !== prev) rank = i + 1;
      prev = key;
      standings.push({ id: p.id, nick: p.nick, color: p.color, rank, alive: p.alive, kills: p.kills, selfKo: p.selfKo, reason: p.elimReason });
    });
    return { reason, winnerId, drawIds, standings, durationMs: Math.max(0, now - this.startAt) };
  }

  // ---------------------------------------------------------------- serialization

  snapshot(now) {
    const players = [];
    for (const p of this.players.values()) {
      let bc = 0;
      for (const b of this.bombs.values()) if (b.owner === p.id) bc++;
      players.push({
        id: p.id, x: round3(p.x), y: round3(p.y), fx: round3(p.fx), fy: round3(p.fy),
        a: p.alive ? 1 : 0, c: p.connected ? 1 : 0, mv: p.moving ? 1 : 0,
        sh: p.shield ? 1 : 0, sl: now < p.slipUntil ? 1 : 0,
        mb: p.maxBombs, bc, rg: p.range, sp: Math.max(0, Math.round(p.speedUntil - now)),
        det: p.det, tr: p.traps, kk: p.kick ? 1 : 0,
      });
    }
    return {
      t: now,
      ph: this.phase,
      cd: this.phase === 'countdown' ? Math.max(0, this.startAt - now) : 0,
      tl: this.phase === 'active' ? Math.max(0, this.endsAt - now) : (this.phase === 'countdown' ? C.MATCH_MS : 0),
      p: players,
      b: [...this.bombs.values()].map((b) => ({ id: b.id, x: b.cx, y: b.cy, o: b.owner, l: Math.max(0, b.explodeAt - now) })),
      u: [...this.powerups.values()].map((u) => ({ id: u.id, x: u.x, y: u.y, k: u.type })),
      tr: [...this.traps.values()].map((t) => ({ id: t.id, x: t.x, y: t.y })),
      cr: this.crateCount,
    };
  }

  /** Everything a client needs to (re)build the match view. */
  fullState(now) {
    return {
      config: this.config(),
      grid: Array.from(this.grid),
      players: [...this.players.values()].map((p) => ({ id: p.id, nick: p.nick, color: p.color, slot: p.slot })),
      flames: this.flames.filter((f) => f.until > now).map((f) => ({
        gid: f.gid, ms: f.until - now,
        cells: Array.from(f.cells.keys()).map((k) => [k % COLS, Math.floor(k / COLS)]),
      })),
      snap: this.snapshot(now),
    };
  }
}

module.exports = { Game, generateGrid, spawnSafeCells, SPAWNS, FLOOR, WALL, CRATE, POWERUP_TYPES, mulberry32 };
