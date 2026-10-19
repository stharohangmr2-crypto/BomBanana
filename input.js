// Keyboard + touch joystick + action buttons. Produces intent only (a direction vector and button presses).
const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
const BOMB_KEYS = new Set(['Space']);
const DET_KEYS = new Set(['KeyE', 'Enter']);
const TRAP_KEYS = new Set(['KeyQ', 'KeyF', 'ShiftLeft']);

export class Controls {
  constructor(els, handlers) {
    this.els = els;
    this.h = handlers; // { move(dx,dy), bomb(), detonate(), trap() }
    this.enabled = false;
    this.keys = new Set();
    this.joy = { id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
    this.radius = 55;
    this._bind();
  }

  setEnabled(on) {
    this.enabled = on;
    this.els.controls.classList.toggle('off', !on);
    if (!on) this.reset();
  }

  /** Release every held input and tell the game we stopped. */
  reset() {
    this.keys.clear();
    this._endJoy();
    for (const b of [this.els.bomb, this.els.det, this.els.trap]) b.classList.remove('active');
    this.h.move(0, 0);
  }

  _emitMove() {
    let x = 0, y = 0;
    for (const k of this.keys) { const v = MOVE_KEYS[k]; if (v) { x += v[0]; y += v[1]; } }
    if (x === 0 && y === 0) { x = this.joy.dx; y = this.joy.dy; }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    this.h.move(Math.round(x * 100) / 100, Math.round(y * 100) / 100);
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return;
      const c = e.code;
      if (MOVE_KEYS[c]) { this.keys.add(c); this._emitMove(); e.preventDefault(); return; }
      if (e.repeat) { if (BOMB_KEYS.has(c) || DET_KEYS.has(c) || TRAP_KEYS.has(c)) e.preventDefault(); return; }
      if (BOMB_KEYS.has(c)) { this.h.bomb(); e.preventDefault(); }
      else if (DET_KEYS.has(c)) { this.h.detonate(); e.preventDefault(); }
      else if (TRAP_KEYS.has(c)) { this.h.trap(); e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => {
      if (MOVE_KEYS[e.code] && this.keys.delete(e.code)) this._emitMove();
    });
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });

    // Floating joystick: appears where the thumb lands inside the left zone.
    const zone = this.els.zone;
    zone.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.joy.id !== null) return;
      e.preventDefault();
      const r = zone.getBoundingClientRect();
      this.joy.id = e.pointerId;
      this.joy.cx = e.clientX; this.joy.cy = e.clientY;
      this.els.base.style.left = `${e.clientX - r.left}px`;
      this.els.base.style.top = `${e.clientY - r.top}px`;
      this.els.base.hidden = false;
      this.els.knob.style.transform = 'translate(0px, 0px)';
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this._moveJoy(e);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === this.joy.id) { e.preventDefault(); this._moveJoy(e); } });
    const end = (e) => { if (e.pointerId === this.joy.id) { this._endJoy(); this._emitMove(); } };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());

    const press = (el, fn) => {
      el.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        el.classList.add('active');
        fn();
      });
      const up = () => el.classList.remove('active');
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    press(this.els.bomb, () => this.h.bomb());
    press(this.els.det, () => this.h.detonate());
    press(this.els.trap, () => this.h.trap());

    // Stop iOS pinch-zoom / double-tap zoom and page scrolling while playing.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
    document.addEventListener('touchmove', (e) => { if (this.enabled) e.preventDefault(); }, { passive: false });
  }

  _moveJoy(e) {
    let dx = e.clientX - this.joy.cx, dy = e.clientY - this.joy.cy;
    const len = Math.hypot(dx, dy);
    const clamped = Math.min(len, this.radius);
    const nx = len > 0 ? dx / len : 0, ny = len > 0 ? dy / len : 0;
    this.els.knob.style.transform = `translate(${nx * clamped}px, ${ny * clamped}px)`;
    const mag = Math.min(1, len / this.radius);
    const dead = 0.22;
    const eff = mag < dead ? 0 : (mag - dead) / (1 - dead);
    this.joy.dx = nx * eff; this.joy.dy = ny * eff;
    this._emitMove();
  }

  _endJoy() {
    if (this.joy.id === null) return;
    const zone = this.els.zone;
    try { zone.releasePointerCapture(this.joy.id); } catch (err) { /* ignore */ }
    this.joy.id = null; this.joy.dx = 0; this.joy.dy = 0;
    this.els.base.hidden = true;
  }

  setAvailability({ det, trap }) {
    this.els.det.hidden = !det;
    this.els.trap.hidden = !trap;
  }
}
