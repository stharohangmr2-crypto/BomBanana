'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/config');
const { Game, generateGrid, spawnSafeCells, FLOOR, WALL, CRATE } = require('../src/game');

const COLS = C.COLS, ROWS = C.ROWS;
const idx = (x, y) => y * COLS + x;
const PL = [
  { id: 'A', nick: 'A', color: '#ffd43b', slot: 0 },
  { id: 'B', nick: 'B', color: '#ff6b9d', slot: 1 },
  { id: 'C', nick: 'C', color: '#38d9e8', slot: 2 },
  { id: 'D', nick: 'D', color: '#7ae05a', slot: 3 },
];

/** An active match on an empty arena (walls only), so each test controls exactly what exists. */
function arena(n = 2) {
  const g = new Game({ seed: 1, players: PL.slice(0, n), startAt: 0 });
  for (let y = 1; y < ROWS - 1; y++) for (let x = 1; x < COLS - 1; x++) if (!(x % 2 === 0 && y % 2 === 0)) g.grid[idx(x, y)] = FLOOR;
  g.crateCount = 0;
  g.update(0);
  assert.equal(g.phase, 'active');
  return g;
}
const put = (g, id, x, y) => { const p = g.players.get(id); p.x = x + 0.5; p.y = y + 0.5; return p; };
const run = (g, from, to, step = 33) => { for (let t = from; t <= to; t += step) g.update(t); };

test('grid: borders and pillars are walls, spawn zones are crate-free, same seed gives same map', () => {
  const g = generateGrid(42);
  for (let x = 0; x < COLS; x++) { assert.equal(g[idx(x, 0)], WALL); assert.equal(g[idx(x, ROWS - 1)], WALL); }
  for (let y = 0; y < ROWS; y++) { assert.equal(g[idx(0, y)], WALL); assert.equal(g[idx(COLS - 1, y)], WALL); }
  assert.equal(g[idx(2, 2)], WALL);
  for (let s = 0; s < 4; s++) for (const [x, y] of spawnSafeCells(s)) assert.equal(g[idx(x, y)], FLOOR);
  assert.deepEqual(Array.from(generateGrid(42)), Array.from(g));
  assert.notDeepEqual(Array.from(generateGrid(43)), Array.from(g));
  assert.ok(Array.from(g).filter((v) => v === CRATE).length > 20);
});

test('countdown: no input or bombs are accepted before the match is active', () => {
  const g = new Game({ seed: 1, players: PL.slice(0, 2), startAt: 1000 });
  g.update(500);
  assert.equal(g.phase, 'countdown');
  assert.equal(g.setInput('A', 1, 0, 500), false);
  assert.equal(g.placeBomb('A', 500).ok, false);
});

test('movement: speed is server-controlled and clients cannot move faster by sending big vectors', () => {
  const g = arena();
  put(g, 'A', 1, 1);
  g.setInput('A', 1000, 0, 0); // normalised to length 1
  run(g, 33, 1000);
  const p = g.players.get('A');
  const travelled = p.x - 1.5;
  assert.ok(travelled > 3.2 && travelled < 3.9, `travelled ${travelled}`); // ~3.6 cells/s
  assert.equal(g.setInput('A', NaN, 0, 1000), false);
  assert.equal(g.setInput('A', 'x', 0, 1000), false);
});

test('movement: walls and crates block, no walking through them', () => {
  const g = arena();
  g.grid[idx(4, 1)] = CRATE; // crate east of A's lane
  const p = put(g, 'A', 1, 1);
  g.setInput('A', 1, 0, 0);
  for (let t = 33; t <= 3000; t += 33) { g.update(t); g.setInput('A', 1, 0, t); }
  assert.ok(p.x < 4 - C.HALF + 1e-6, `x=${p.x}`);
  g.setInput('A', -1, 0, 3000);
  for (let t = 3033; t <= 6000; t += 33) { g.update(t); g.setInput('A', -1, 0, t); }
  assert.ok(p.x >= 1 + C.HALF - 1e-6, `x=${p.x}`); // stopped by the border wall
  g.setInput('A', 0, -1, 6000);
  for (let t = 6033; t <= 9000; t += 33) { g.update(t); g.setInput('A', 0, -1, t); }
  assert.ok(p.y >= 1 + C.HALF - 1e-6);
});

test('movement: input expires if the client goes silent', () => {
  const g = arena();
  const p = put(g, 'A', 1, 1);
  g.setInput('A', 1, 0, 0);
  run(g, 33, 4000);
  assert.ok(p.x < 1.5 + C.INPUT_TIMEOUT_MS / 1000 * C.BASE_SPEED + 0.5);
});

test('bomb placement: legal cell only, cooldown, capacity, no duplicates on one cell', () => {
  const g = arena();
  const p = put(g, 'A', 1, 1);
  assert.equal(g.placeBomb('A', 100).ok, true);
  assert.equal(g.placeBomb('A', 110).reason, 'cooldown');
  assert.equal(g.placeBomb('A', 500).reason, 'capacity'); // max bombs = 1
  p.maxBombs = 3;
  assert.equal(g.placeBomb('A', 500).reason, 'occupied'); // same cell
  put(g, 'A', 3, 1);
  assert.equal(g.placeBomb('A', 600).ok, true);
  put(g, 'A', 5, 1);
  assert.equal(g.placeBomb('A', 1000).ok, true);
  put(g, 'A', 7, 1);
  assert.equal(g.placeBomb('A', 1400).reason, 'capacity');
  // spamming the button never exceeds capacity
  for (let t = 2000; t < 2100; t++) g.placeBomb('A', t);
  assert.ok(g.bombs.size <= 3);
  // crate / wall cells are illegal
  g.bombs.clear(); g.bombCells.clear();
  g.grid[idx(3, 1)] = CRATE; put(g, 'A', 3, 1);
  assert.equal(g.placeBomb('A', 5000).reason, 'blocked');
});

test('explosion: cross shape, range, stops at walls, destroys first crate only', () => {
  const g = arena();
  put(g, 'B', 11, 9);
  put(g, 'A', 5, 5);
  g.players.get('A').range = 3;
  g.grid[idx(7, 5)] = CRATE; g.grid[idx(8, 5)] = CRATE; g.crateCount = 2;
  g.placeBomb('A', 0);
  put(g, 'A', 5, 1); // step away so A survives
  g.update(C.FUSE_MS + 1);
  const boom = g.drainEvents().find((e) => e.t === 'boom');
  assert.ok(boom);
  const set = new Set(boom.cells.map(([x, y]) => `${x},${y}`));
  assert.ok(set.has('5,5') && set.has('6,5') && set.has('7,5')); // crate at 7,5 included
  assert.ok(!set.has('8,5')); // stopped by first crate
  assert.equal(g.grid[idx(7, 5)], FLOOR);
  assert.equal(g.grid[idx(8, 5)], CRATE);
  // upward: range 3 -> (5,4),(5,3),(5,2); (5,2) is open (x=5 odd) so reaches
  assert.ok(set.has('5,4') && set.has('5,3') && set.has('5,2'));
  assert.equal(g.crateCount, 1);
});

test('explosion: indestructible pillar blocks the blast', () => {
  const g = arena();
  put(g, 'A', 1, 2); // (1,2): neighbour (2,2) is a pillar
  g.players.get('A').range = 5;
  put(g, 'B', 11, 9);
  g.placeBomb('A', 0);
  put(g, 'A', 1, 6);
  g.update(C.FUSE_MS + 1);
  const boom = g.drainEvents().find((e) => e.t === 'boom');
  const set = new Set(boom.cells.map(([x, y]) => `${x},${y}`));
  assert.ok(!set.has('2,2') && !set.has('3,2'));
  assert.ok(set.has('1,3') && set.has('1,1'));
});

test('fuse: bomb does not explode early and explodes after FUSE_MS', () => {
  const g = arena();
  put(g, 'B', 11, 9);
  put(g, 'A', 1, 1);
  g.placeBomb('A', 0);
  put(g, 'A', 5, 5);
  g.update(C.FUSE_MS - 50);
  assert.equal(g.bombs.size, 1);
  g.update(C.FUSE_MS + 5);
  assert.equal(g.bombs.size, 0);
});

test('chain reaction: one bomb triggers another and the blast shapes are merged', () => {
  const g = arena();
  put(g, 'B', 11, 9);
  const a = put(g, 'A', 1, 1);
  a.maxBombs = 2; a.range = 3;
  g.placeBomb('A', 0);
  put(g, 'A', 3, 1);
  g.placeBomb('A', 400); // explodes 400ms later than the first
  put(g, 'A', 5, 5);
  g.update(C.FUSE_MS + 1);
  assert.equal(g.bombs.size, 0, 'second bomb must be chained');
  const booms = g.drainEvents().filter((e) => e.t === 'boom');
  assert.equal(booms.length, 1, 'one flame group for the whole chain');
  assert.equal(booms[0].origins.length, 2);
});

test('damage: eliminated exactly once per explosion even with overlapping blasts', () => {
  const g = arena(3);
  put(g, 'C', 11, 9);
  const a = put(g, 'A', 5, 5); a.maxBombs = 3;
  const b = put(g, 'B', 5, 5);
  g.placeBomb('A', 0);
  g.placeBomb('A', 400);
  put(g, 'A', 5, 1); // A moves out of lines? (5,1) is in column 5 -> still in blast; place A safe instead
  const aa = g.players.get('A'); aa.x = 1.5; aa.y = 1.5;
  b.x = 5.5; b.y = 5.5;
  g.update(C.FUSE_MS + 1);
  g.update(C.FUSE_MS + 40);
  g.update(C.FUSE_MS + 80);
  const elims = g.drainEvents().filter((e) => e.t === 'elim' && e.id === 'B');
  assert.equal(elims.length, 1);
  assert.equal(b.alive, false);
  assert.equal(g.players.get('A').kills, 1);
});

test('shield: absorbs exactly one explosion, then the player is vulnerable to the next', () => {
  const g = arena(3);
  put(g, 'C', 11, 9);
  const b = put(g, 'B', 5, 5); b.shield = true;
  const a = put(g, 'A', 5, 5); a.maxBombs = 2;
  g.placeBomb('A', 0);
  a.x = 1.5; a.y = 1.5;
  g.update(C.FUSE_MS + 1);
  assert.equal(b.alive, true);
  assert.equal(b.shield, false);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.t === 'shield' && e.id === 'B'));
  // second explosion after the invulnerability window and after the first flame is gone
  const t2 = C.FUSE_MS + 3000;
  g.update(t2); // retire old flames
  put(g, 'A', 5, 5);
  g.placeBomb('A', t2 + 10);
  a.x = 1.5; a.y = 1.5;
  b.x = 5.5; b.y = 5.5;
  g.update(t2 + 10 + C.FUSE_MS + 1);
  assert.equal(b.alive, false);
});

test('win: last player standing wins and the match ends', () => {
  const g = arena(2);
  put(g, 'A', 1, 1);
  put(g, 'B', 5, 5);
  g.placeBomb('B', 0);
  put(g, 'B', 5, 5);
  g.players.get('B').x = 5.5;
  // B stands on own bomb: B dies; A wins
  g.update(C.FUSE_MS + 1);
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winnerId, 'A');
  assert.equal(g.result.reason, 'last_standing');
  assert.equal(g.result.standings[0].id, 'A');
  assert.equal(g.result.standings[0].rank, 1);
  assert.equal(g.players.get('B').selfKo, 1);
});

test('draw: simultaneous elimination of everyone is a draw', () => {
  const g = arena(2);
  put(g, 'A', 5, 5);
  put(g, 'B', 5, 6);
  g.placeBomb('A', 0);
  g.update(C.FUSE_MS + 1);
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winnerId, null);
  assert.equal(g.result.reason, 'all_eliminated');
  assert.deepEqual(new Set(g.result.drawIds), new Set(['A', 'B']));
});

test('time up: survivors draw when the clock runs out', () => {
  const g = arena(2);
  g.update(C.MATCH_MS + 5);
  assert.equal(g.phase, 'over');
  assert.equal(g.result.reason, 'time_up');
  assert.equal(g.result.winnerId, null);
  assert.equal(g.result.drawIds.length, 2);
});

test('power-ups: every type has a real effect and is awarded exactly once', () => {
  const g = arena(2);
  const p = put(g, 'A', 3, 3);
  const give = (type) => { g.powerups.set(++g.seq.up, { id: g.seq.up, x: 3, y: 3, type }); g.update(g.lastUpdate + 33); };
  give('bomb'); assert.equal(p.maxBombs, C.START_MAX_BOMBS + 1);
  give('range'); assert.equal(p.range, C.START_RANGE + 1);
  give('speed'); assert.ok(p.speedUntil > g.lastUpdate);
  give('shield'); assert.equal(p.shield, true);
  give('detonator'); assert.equal(p.det, C.DET_CHARGES);
  give('banana'); assert.equal(p.traps, 1);
  give('kick'); assert.equal(p.kick, true);
  assert.equal(g.powerups.size, 0);
  // same pickup cannot be collected by two players on the same tick
  const q = put(g, 'B', 3, 3);
  p.x = 3.5; p.y = 3.5;
  const before = p.maxBombs + q.maxBombs;
  g.powerups.set(++g.seq.up, { id: g.seq.up, x: 3, y: 3, type: 'bomb' });
  g.update(g.lastUpdate + 33);
  assert.equal(p.maxBombs + q.maxBombs, before + 1);
});

test('speed boost expires', () => {
  const g = arena(2);
  const p = put(g, 'A', 3, 3);
  g.powerups.set(1, { id: 1, x: 3, y: 3, type: 'speed' });
  g.update(100);
  const snap1 = g.snapshot(200);
  assert.ok(snap1.p.find((x) => x.id === 'A').sp > 0);
  const snap2 = g.snapshot(100 + C.SPEED_MS + 10);
  assert.equal(snap2.p.find((x) => x.id === 'A').sp, 0);
  g.setInput('A', 1, 0, 100 + C.SPEED_MS + 10);
  assert.ok(p.speedUntil < 100 + C.SPEED_MS + 100);
});

test('remote detonator: only works with a charge and only on the owner’s own older bomb', () => {
  const g = arena(2);
  put(g, 'B', 11, 9);
  const a = put(g, 'A', 5, 5);
  g.placeBomb('A', 100);
  assert.equal(g.detonate('A', 600).reason, 'no_detonator');
  a.det = 1;
  assert.equal(g.detonate('B', 600).ok, false);
  assert.equal(g.detonate('A', 200).reason, 'no_bomb'); // too fresh
  assert.equal(g.detonate('A', 600).ok, true);
  assert.equal(a.det, 0);
  a.x = 1.5; a.y = 1.5;
  g.update(601);
  assert.equal(g.bombs.size, 0);
});

test('banana trap: slips an opponent, then disappears; owner is not slipped during arming', () => {
  const g = arena(2);
  const a = put(g, 'A', 3, 3); a.traps = 1;
  assert.equal(g.placeTrap('A', 100).ok, true);
  assert.equal(g.placeTrap('A', 110).ok, false);
  g.update(150);
  assert.equal(a.slipUntil, 0); // arming window protects the owner
  const b = put(g, 'B', 3, 3);
  b.dirX = 1; b.dirY = 0; b.lastInputAt = 200;
  g.update(233);
  assert.ok(b.slipUntil > 233);
  assert.equal(g.traps.size, 0);
  const x0 = b.x;
  b.dirX = 0; b.lastInputAt = 233; // cannot steer while slipping
  g.update(433);
  assert.ok(b.x > x0, 'keeps sliding');
});

test('bomb kick: pushes a bomb exactly one cell when the destination is free', () => {
  const g = arena(2);
  put(g, 'B', 11, 9);
  const a = put(g, 'A', 5, 5);
  g.placeBomb('A', 0);
  a.x = 4.5; a.y = 5.5; // step off the bomb
  g.update(100);
  a.kick = true;
  g.setInput('A', 1, 0, 100);
  let kicks = 0;
  for (let t = 133; t <= 500 && kicks === 0; t += 33) {
    g.update(t);
    kicks += g.drainEvents().filter((e) => e.t === 'kick').length;
    g.setInput('A', 1, 0, t);
  }
  g.setInput('A', 0, 0, 500); // stop pushing: one bump moves the bomb exactly one cell
  const bomb = [...g.bombs.values()][0];
  assert.equal(kicks, 1);
  assert.equal(bomb.cx, 6);
  assert.equal(bomb.cy, 5);
  // keep pushing: the bomb advances cell by cell but is refused at the wall
  const g2 = arena(2);
  put(g2, 'B', 11, 9);
  const a2 = put(g2, 'A', 1, 3);
  g2.placeBomb('A', 0);
  a2.x = 1.5; a2.y = 4.5; a2.kick = true;
  g2.update(100);
  g2.setInput('A', 0, -1, 100);
  for (let t = 133; t <= 700; t += 33) { g2.update(t); g2.setInput('A', 0, -1, t); }
  const b2 = [...g2.bombs.values()][0];
  assert.equal(b2.cy, 1); // pushed up the open lane but never into the border wall (row 0)
  assert.equal(g2.grid[idx(1, 0)], WALL);
});

test('drops: destroyed crates may leave server-created pickups; blasts destroy existing pickups', () => {
  const g = arena(2);
  put(g, 'B', 11, 9);
  put(g, 'A', 5, 5);
  g.powerups.set(99, { id: 99, x: 6, y: 5, type: 'bomb' });
  g.placeBomb('A', 0);
  put(g, 'A', 1, 1);
  g.update(C.FUSE_MS + 1);
  assert.equal(g.powerups.has(99), false);
});

test('disconnect: a disconnected player stands still; elimination by disconnect can end the match', () => {
  const g = arena(2);
  const a = put(g, 'A', 3, 3);
  g.setInput('A', 1, 0, 0);
  g.setConnected('A', false);
  g.update(500);
  assert.equal(a.x, 3.5);
  g.eliminateByDisconnect('A', 600, 'disconnect');
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winnerId, 'B');
});

test('flames are rejected as bomb placement cells while burning', () => {
  const g = arena(2);
  put(g, 'B', 11, 9);
  put(g, 'A', 5, 5);
  g.placeBomb('A', 0);
  put(g, 'A', 1, 1);
  g.update(C.FUSE_MS + 1);
  put(g, 'A', 6, 5);
  assert.equal(g.placeBomb('A', C.FUSE_MS + 400).reason, 'flame');
});

test('snapshot is plain JSON-safe data without secrets', () => {
  const g = arena(2);
  const s = JSON.parse(JSON.stringify(g.snapshot(10)));
  assert.equal(s.p.length, 2);
  assert.equal(s.ph, 'active');
  assert.ok(!('token' in s.p[0]));
  const f = JSON.parse(JSON.stringify(g.fullState(10)));
  assert.equal(f.grid.length, COLS * ROWS);
});
