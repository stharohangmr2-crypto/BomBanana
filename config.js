'use strict';
// All gameplay constants live here. Units: grid cells and milliseconds.
module.exports = Object.freeze({
  COLS: 13,
  ROWS: 11,
  TICK_HZ: 30,

  MIN_PLAYERS: 2,
  MAX_PLAYERS: 4,
  COUNTDOWN_MS: 3500,
  MATCH_MS: 180000,

  FUSE_MS: 2500,
  FLAME_MS: 600,
  BOMB_COOLDOWN_MS: 300,
  REMOTE_MIN_FUSE_AGE_MS: 350,
  KICK_COOLDOWN_MS: 220,

  START_MAX_BOMBS: 1,
  START_RANGE: 2,
  CAP_MAX_BOMBS: 6,
  CAP_RANGE: 8,

  HALF: 0.3, // player half-size (collision box is 0.6 x 0.6 cells)
  BASE_SPEED: 3.6, // cells / second
  SPEED_MULT: 1.5,
  SPEED_MS: 8000,
  SLIP_MS: 1100,
  SLIP_MULT: 1.2,
  TRAP_MS: 12000,
  TRAP_ARM_MS: 600,
  SHIELD_INVULN_MS: 700,
  DET_CHARGES: 3,
  CAP_TRAPS: 3,
  INPUT_TIMEOUT_MS: 1500,

  CRATE_DENSITY: 0.72,
  DROP_CHANCE: 0.38,
  DROP_WEIGHTS: { bomb: 20, range: 20, speed: 14, shield: 10, detonator: 10, banana: 12, kick: 10 },

  RECONNECT_GRACE_MS: 20000,
});
