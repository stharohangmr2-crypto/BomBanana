import * as THREE from 'three';

// Coordinate system: logical grid cell (cx, cy) with float positions in cell units maps to
//   world X = x - cols/2,  world Z = y - rows/2,  world Y = up.
// Cell (0,0) is the top-left (far-left) corner as seen by the camera. Visual state is never used for game logic.

const DEG = Math.PI / 180;
const TILE = 0, WALL = 1, CRATE = 2;
const MAX_FLAMES = 160;
const MAX_PARTICLES = 520;
const SNAP_DELAY_MS = 100;

const TYPE_COLORS = { bomb: 0x222233, range: 0xff8a2b, speed: 0x32d9ff, shield: 0x4da3ff, detonator: 0xff4d4d, banana: 0xffd43b, kick: 0x5de08b };

export class GameScene {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x0c2a33);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0c2a33, 28, 70);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
    this.maxDpr = 2;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.frameAvg = 16;
    this.frameCount = 0;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x77a58b, 1.9);
    this.sun = new THREE.DirectionalLight(0xfff0c8, 2.3);
    this.sun.position.set(6, 16, 9);
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this._makeShared();
    this.dynamic = new THREE.Group(); // everything that belongs to the current match
    this.scene.add(this.dynamic);

    this.cols = 13; this.rows = 11;
    this.grid = new Uint8Array(0);
    this.players = new Map(); this.bombViews = new Map(); this.upViews = new Map(); this.trapViews = new Map();
    this.snaps = []; this.latest = null; this.latestAt = 0;
    this.localId = null;
    this.camTarget = new THREE.Vector3();
    this._tmpTarget = new THREE.Vector3();
    this.shake = 0;
    this.celebrate = null;
    this.crateCount = 0;
    this.flameFree = []; this.flameActive = [];
    this.crateAnims = [];
    this.dummy = new THREE.Object3D();
    this.disposables = [];
    this.pIdx = 0;
    this.hasMatch = false;
    this.resize();
  }

  // ------------------------------------------------------------------ shared resources

  _makeShared() {
    const g = this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      tile: new THREE.BoxGeometry(1, 0.2, 1),
      sphere: new THREE.SphereGeometry(0.5, 14, 10),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
      cone: new THREE.ConeGeometry(0.5, 1, 8),
      plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      circle: new THREE.CircleGeometry(0.5, 18).rotateX(-Math.PI / 2),
      ring: new THREE.RingGeometry(0.36, 0.5, 22).rotateX(-Math.PI / 2),
      ico: new THREE.IcosahedronGeometry(0.5, 0),
      oct: new THREE.OctahedronGeometry(0.5, 0),
    };
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.12, 0), new THREE.Vector3(0.1, 0.36, 0),
      new THREE.Vector3(0.13, 0.64, 0), new THREE.Vector3(0.02, 0.9, 0),
    ]);
    g.banana = new THREE.TubeGeometry(curve, 10, 0.2, 7, false);
    g.peel = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.3, 0, 0.0), new THREE.Vector3(-0.1, 0.1, 0.12), new THREE.Vector3(0.12, 0.1, 0.12), new THREE.Vector3(0.3, 0, 0.0),
    ]), 8, 0.1, 6, false);

    const L = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
    this.mat = {
      floorA: L(0xf3e3b0), floorB: L(0xe6d29a),
      border: L(0x2c5a6e), pillar: L(0x6b63d9),
      crate: L(0xc98a4b), band: L(0x7a4a1f),
      ground: L(0x2f7d5b), trunk: L(0x7a4a1f), leaf: L(0x39b36b), rock: L(0x8a93a0), leaf2: L(0x2a9a5a),
      bomb: L(0x1d1d2b), cap: L(0x555566), fuse: L(0x8a5a2b),
      spark: new THREE.MeshBasicMaterial({ color: 0xffb02e }),
      white: L(0xffffff), black: L(0x15151f), stem: L(0x6b4a12), shoe: L(0x3a2a1a),
      flameArm: new THREE.MeshBasicMaterial({ color: 0xff7a1a }),
      flameCenter: new THREE.MeshBasicMaterial({ color: 0xfff3b0 }),
      danger: new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.3, depthWrite: false }),
      dangerHot: new THREE.MeshBasicMaterial({ color: 0xff1f1f, transparent: true, opacity: 0.55, depthWrite: false }),
      shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
      shield: new THREE.MeshBasicMaterial({ color: 0x66c2ff, transparent: true, opacity: 0.35, depthWrite: false }),
      peel: L(0xffe14d), baseDisc: L(0xfff6dc),
    };

    // Fixed-size particle pool (never grows).
    const pos = new Float32Array(MAX_PARTICLES * 3);
    const col = new Float32Array(MAX_PARTICLES * 3);
    for (let i = 0; i < MAX_PARTICLES; i++) pos[i * 3 + 1] = -100;
    this.pPos = pos; this.pCol = col;
    this.pVel = new Float32Array(MAX_PARTICLES * 3);
    this.pLife = new Float32Array(MAX_PARTICLES);
    this.pMax = new Float32Array(MAX_PARTICLES);
    this.pBase = new Float32Array(MAX_PARTICLES * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.2, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  _applyQuality() {
    const q = this.settings.quality;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const high = q === 'high' || (q === 'auto' && !coarse);
    this.maxDpr = q === 'low' ? 1.25 : (high ? 2 : 1.5);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.sun.castShadow = high;
    if (high) {
      const s = this.sun.shadow;
      s.mapSize.set(1024, 1024);
      const r = Math.max(this.cols, this.rows) * 0.62;
      Object.assign(s.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 40 });
      s.camera.updateProjectionMatrix();
      s.bias = -0.0005;
    }
    this.shadowsOn = high;
    this.resize();
  }

  // ------------------------------------------------------------------ match setup / teardown

  cellX(cx) { return cx - this.cols / 2; }
  cellZ(cy) { return cy - this.rows / 2; }

  clearMatch() {
    for (const v of this.bombViews.values()) v.bodyMat.dispose();
    for (const v of this.upViews.values()) v.mats.forEach((m) => m.dispose());
    for (const d of this.disposables) { if (d.dispose) d.dispose(); }
    this.disposables.length = 0;
    this.dynamic.clear();
    this.players.clear(); this.bombViews.clear(); this.upViews.clear(); this.trapViews.clear();
    this.flameFree.length = 0; this.flameActive.length = 0; this.crateAnims.length = 0;
    this.snaps.length = 0; this.latest = null; this.celebrate = null;
    for (let i = 0; i < MAX_PARTICLES; i++) { this.pLife[i] = 0; this.pPos[i * 3 + 1] = -100; }
    this.hasMatch = false;
  }

  setup(payload, localId) {
    this.clearMatch();
    this.localId = localId;
    this.cols = payload.config.cols; this.rows = payload.config.rows;
    this.cfg = payload.config;
    this.grid = Uint8Array.from(payload.grid);
    this._applyQuality();
    const G = this.geo, M = this.mat, dummy = this.dummy;
    const sh = this.shadowsOn;

    // ground + floor tiles (two instanced meshes for the checker pattern)
    const ground = new THREE.Mesh(G.plane, M.ground);
    ground.scale.set(80, 1, 80); ground.position.y = -0.3;
    this.dynamic.add(ground);
    let nA = 0, nB = 0;
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) if (this.grid[y * this.cols + x] !== WALL) ((x + y) % 2 ? nB++ : nA++);
    const floorA = new THREE.InstancedMesh(G.tile, M.floorA, Math.max(1, nA));
    const floorB = new THREE.InstancedMesh(G.tile, M.floorB, Math.max(1, nB));
    floorA.receiveShadow = floorB.receiveShadow = sh;
    let ia = 0, ib = 0;
    // walls: border and pillars get different colours
    let nBorder = 0, nPillar = 0;
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      if (this.grid[y * this.cols + x] !== WALL) continue;
      (x === 0 || y === 0 || x === this.cols - 1 || y === this.rows - 1) ? nBorder++ : nPillar++;
    }
    const wallB = new THREE.InstancedMesh(G.box, M.border, Math.max(1, nBorder));
    const wallP = new THREE.InstancedMesh(G.box, M.pillar, Math.max(1, nPillar));
    wallB.castShadow = wallP.castShadow = sh; wallB.receiveShadow = wallP.receiveShadow = sh;
    let iwb = 0, iwp = 0;
    // crates: body + band, both instanced
    let nCrate = 0;
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === CRATE) nCrate++;
    this.crateBody = new THREE.InstancedMesh(G.box, M.crate, Math.max(1, nCrate));
    this.crateBand = new THREE.InstancedMesh(G.box, M.band, Math.max(1, nCrate));
    this.crateBody.castShadow = sh; this.crateBody.receiveShadow = sh;
    this.crateIndex = new Map();
    let ic = 0;

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const t = this.grid[y * this.cols + x];
        const wx = this.cellX(x) + 0.5, wz = this.cellZ(y) + 0.5;
        if (t !== WALL) {
          dummy.position.set(wx, -0.1, wz); dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
          if ((x + y) % 2) floorB.setMatrixAt(ib++, dummy.matrix); else floorA.setMatrixAt(ia++, dummy.matrix);
        } else {
          dummy.position.set(wx, 0.55, wz); dummy.scale.set(1, 1.1, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
          if (x === 0 || y === 0 || x === this.cols - 1 || y === this.rows - 1) wallB.setMatrixAt(iwb++, dummy.matrix);
          else wallP.setMatrixAt(iwp++, dummy.matrix);
        }
        if (t === CRATE) {
          this.crateIndex.set(y * this.cols + x, ic);
          this._setCrateMatrices(ic, wx, wz, 1);
          ic++;
        }
      }
    }
    for (const m of [floorA, floorB, wallB, wallP, this.crateBody, this.crateBand]) { m.instanceMatrix.needsUpdate = true; this.dynamic.add(m); this.disposables.push(m); }
    this.crateCount = nCrate;

    // danger overlay planes, one per walkable cell
    this.dangerMeshes = new Array(this.grid.length).fill(null);
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      if (this.grid[y * this.cols + x] === WALL) continue;
      const m = new THREE.Mesh(G.plane, M.danger);
      m.scale.set(0.96, 1, 0.96); m.position.set(this.cellX(x) + 0.5, 0.012, this.cellZ(y) + 0.5); m.visible = false;
      this.dangerMeshes[y * this.cols + x] = m; this.dynamic.add(m);
    }
    // flame pool
    for (let i = 0; i < MAX_FLAMES; i++) {
      const m = new THREE.Mesh(G.box, M.flameArm); m.visible = false; this.dynamic.add(m); this.flameFree.push(m);
    }

    this._decorate();

    // players
    for (const meta of payload.players) this.players.set(meta.id, this._buildPlayer(meta));
    this.hasMatch = true;
    this.sun.target.position.set(0, 0, 0);
    for (const f of payload.flames || []) this._spawnFlames(f.cells, [], f.ms, this.cfg.flameMs);
    this.pushSnapshot(payload.snap);
    this.resize();
    // start camera centred
    this.camTarget.set(0, 0, 0.3);
  }

  _setCrateMatrices(i, wx, wz, s) {
    const d = this.dummy;
    d.rotation.set(0, 0, 0);
    d.position.set(wx, 0.45 * s, wz); d.scale.set(0.9 * s, 0.9 * s, 0.9 * s); d.updateMatrix();
    this.crateBody.setMatrixAt(i, d.matrix);
    d.position.set(wx, 0.45 * s, wz); d.scale.set(0.97 * s, 0.14 * s, 0.97 * s); d.updateMatrix();
    this.crateBand.setMatrixAt(i, d.matrix);
    this.crateBody.instanceMatrix.needsUpdate = true; this.crateBand.instanceMatrix.needsUpdate = true;
  }

  _decorate() {
    // Props outside the combat area (purely visual; deterministic positions).
    const G = this.geo, M = this.mat;
    const hx = this.cols / 2 + 1.6, hz = this.rows / 2 + 1.6;
    let k = 0;
    const place = (x, z) => {
      k++;
      if (k % 4 === 0) {
        const r = new THREE.Mesh(G.ico, M.rock); r.scale.set(0.9, 0.6, 0.8); r.position.set(x, 0.1, z); r.rotation.y = k; this.dynamic.add(r);
      } else {
        const t = new THREE.Mesh(G.cyl, M.trunk); t.scale.set(0.22, 1.5 + (k % 3) * 0.2, 0.22); t.position.set(x, 0.6, z);
        const l = new THREE.Mesh(G.cone, k % 2 ? M.leaf : M.leaf2); l.scale.set(1.5, 1.1, 1.5); l.position.set(x, 1.7 + (k % 3) * 0.2, z);
        this.dynamic.add(t, l);
      }
    };
    for (let x = -hx; x <= hx + 0.1; x += 2.6) { place(x, -hz - (Math.abs(x) % 2)); place(x + 0.8, hz + (Math.abs(x) % 1.5)); }
    for (let z = -hz + 2.6; z < hz - 1; z += 2.8) { place(-hx - (Math.abs(z) % 1.5), z); place(hx + (Math.abs(z) % 1.7), z + 0.5); }
  }

  _makeLabel(text, color) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.font = '800 34px "Trebuchet MS", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 8; x.strokeStyle = '#10303a'; x.strokeText(text, 128, 34);
    x.fillStyle = color; x.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sp = new THREE.Sprite(mat); sp.scale.set(1.7, 0.42, 1); sp.renderOrder = 20;
    this.disposables.push(tex, mat);
    return sp;
  }

  _buildPlayer(meta) {
    const G = this.geo, M = this.mat, sh = this.shadowsOn;
    const root = new THREE.Group();
    const body = new THREE.Group(); root.add(body);
    const bodyMat = new THREE.MeshLambertMaterial({ color: meta.color, flatShading: true });
    this.disposables.push(bodyMat);
    const tube = new THREE.Mesh(G.banana, bodyMat); tube.castShadow = sh; body.add(tube);
    const stem = new THREE.Mesh(G.cyl, M.stem); stem.scale.set(0.09, 0.16, 0.09); stem.position.set(0.0, 0.98, 0); stem.rotation.z = 0.35; body.add(stem);
    const tip = new THREE.Mesh(G.sphere, M.stem); tip.scale.set(0.12, 0.12, 0.12); tip.position.set(0, 0.1, 0); body.add(tip);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(G.sphere, M.white); eye.scale.set(0.15, 0.17, 0.12); eye.position.set(0.13 + s * 0.085, 0.62, 0.17);
      const pupil = new THREE.Mesh(G.sphere, M.black); pupil.scale.set(0.07, 0.08, 0.05); pupil.position.set(0.13 + s * 0.085, 0.62, 0.235);
      body.add(eye, pupil);
    }
    const feet = [];
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(G.sphere, M.shoe); f.scale.set(0.16, 0.1, 0.24); f.position.set(0.04 + s * 0.11, 0.05, 0.04); root.add(f); feet.push(f);
    }
    const ringMat = new THREE.MeshBasicMaterial({ color: meta.color }); this.disposables.push(ringMat);
    const ring = new THREE.Mesh(G.ring, ringMat); ring.position.y = 0.03; ring.scale.set(1.15, 1, 1.15); root.add(ring);
    const blob = new THREE.Mesh(G.circle, M.shadow); blob.position.y = 0.025; blob.scale.set(0.8, 1, 0.8); root.add(blob);
    const shield = new THREE.Mesh(G.sphere, M.shield); shield.scale.set(1.15, 1.25, 1.15); shield.position.y = 0.55; shield.visible = false; root.add(shield);
    const label = this._makeLabel(meta.nick, meta.color); label.position.y = 1.6; root.add(label);
    this.dynamic.add(root);
    return {
      id: meta.id, root, body, feet, shield, ring, label, rx: 0, ry: 0, init: false, phase: 0, yaw: 0,
      alive: true, dying: -1, slip: false, hidden: false, moving: false,
    };
  }

  // ------------------------------------------------------------------ network input

  pushSnapshot(snap) {
    const now = performance.now();
    this.snaps.push({ at: now, s: snap });
    if (this.snaps.length > 10) this.snaps.shift();
    this.latest = snap; this.latestAt = now;
    this._syncDiscrete(snap, now);
  }

  _syncDiscrete(snap, now) {
    // bombs
    const seen = new Set();
    for (const b of snap.b) {
      seen.add(b.id);
      let v = this.bombViews.get(b.id);
      if (!v) v = this._addBomb(b);
      if (v.cx !== b.x || v.cy !== b.y) { v.cx = b.x; v.cy = b.y; }
      v.left = b.l; v.at = now;
    }
    for (const [id, v] of this.bombViews) if (!seen.has(id)) this._removeBomb(id, v);
    // power-ups
    const seenU = new Set();
    for (const u of snap.u) {
      seenU.add(u.id);
      if (!this.upViews.has(u.id)) this._addPowerup(u);
    }
    for (const [id, v] of this.upViews) if (!seenU.has(id)) { this.dynamic.remove(v.group); v.mats.forEach((m) => m.dispose()); this.upViews.delete(id); }
    // traps
    const seenT = new Set();
    for (const t of snap.tr) {
      seenT.add(t.id);
      if (!this.trapViews.has(t.id)) {
        const m = new THREE.Mesh(this.geo.peel, this.mat.peel);
        m.position.set(this.cellX(t.x) + 0.5, 0.1, this.cellZ(t.y) + 0.5); m.rotation.y = (t.id * 1.7) % 6.28; m.scale.set(1.4, 1.2, 1.4);
        this.dynamic.add(m); this.trapViews.set(t.id, m);
      }
    }
    for (const [id, m] of this.trapViews) if (!seenT.has(id)) { this.dynamic.remove(m); this.trapViews.delete(id); }
    // players: status flags
    for (const p of snap.p) {
      const v = this.players.get(p.id);
      if (!v) continue;
      v.shield.visible = !!p.sh && !!p.a;
      v.slip = !!p.sl;
      if (!p.a && v.alive) { v.alive = false; if (v.dying < 0) v.dying = 0; }
    }
    this._updateDanger(snap);
  }

  _updateDanger(snap) {
    if (snap.b.length === 0 && !this.hadDanger) return;
    this.hadDanger = snap.b.length > 0;
    const cols = this.cols, rows = this.rows;
    if (!this.dangerLeft || this.dangerLeft.length !== this.grid.length) this.dangerLeft = new Float32Array(this.grid.length);
    const dl = this.dangerLeft; dl.fill(-1);
    const bombAt = new Map();
    for (const b of snap.b) bombAt.set(b.y * cols + b.x, b);
    const rangeOf = (b) => { const p = snap.p.find((q) => q.id === b.o); return p ? p.rg : 2; };
    // Approximation for display only: ignores chain timing and bombs' own range upgrades after placement.
    for (const b of snap.b) {
      const r = rangeOf(b);
      const mark = (k) => { if (dl[k] < 0 || b.l < dl[k]) dl[k] = b.l; };
      mark(b.y * cols + b.x);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let i = 1; i <= r; i++) {
          const x = b.x + dx * i, y = b.y + dy * i;
          if (x < 0 || y < 0 || x >= cols || y >= rows) break;
          const k = y * cols + x, t = this.grid[k];
          if (t === WALL) break;
          mark(k);
          if (t === CRATE || bombAt.has(k)) break;
        }
      }
    }
    for (let k = 0; k < dl.length; k++) {
      const m = this.dangerMeshes[k]; if (!m) continue;
      if (dl[k] < 0) { m.visible = false; continue; }
      m.visible = true;
      m.material = dl[k] < 900 ? this.mat.dangerHot : this.mat.danger;
    }
  }

  // ------------------------------------------------------------------ discrete events

  handleEvent(ev) {
    switch (ev.t) {
      case 'boom': {
        for (const [x, y] of ev.origins) {
          for (const [id, v] of this.bombViews) if (v.cx === x && v.cy === y) this._removeBomb(id, v);
        }
        this._spawnFlames(ev.cells, ev.origins, ev.ms, ev.ms);
        for (const [x, y] of ev.origins) this._burst(this.cellX(x) + 0.5, 0.4, this.cellZ(y) + 0.5, 26, [1, 0.7, 0.2], 4.5, 0.7);
        this.shake = Math.min(1, this.shake + 0.55);
        break;
      }
      case 'crate': {
        const k = ev.y * this.cols + ev.x;
        this.grid[k] = TILE;
        const i = this.crateIndex.get(k);
        if (i !== undefined) { this.crateAnims.push({ i, x: ev.x, y: ev.y, t: 0 }); this.crateIndex.delete(k); }
        this.crateCount--;
        this._burst(this.cellX(ev.x) + 0.5, 0.5, this.cellZ(ev.y) + 0.5, 12, [0.8, 0.5, 0.2], 3, 0.6);
        break;
      }
      case 'drop': this._burst(this.cellX(ev.x) + 0.5, 0.6, this.cellZ(ev.y) + 0.5, 10, [1, 1, 0.6], 2, 0.8); break;
      case 'pickup': {
        const c = new THREE.Color(TYPE_COLORS[ev.k] || 0xffffff);
        this._burst(this.cellX(ev.x) + 0.5, 0.6, this.cellZ(ev.y) + 0.5, 16, [Math.max(0.4, c.r), Math.max(0.4, c.g), Math.max(0.4, c.b)], 3, 0.7);
        break;
      }
      case 'elim': {
        const v = this.players.get(ev.id);
        if (v) {
          if (v.dying < 0) v.dying = 0;
          v.alive = false;
          this._burst(v.root.position.x, 0.7, v.root.position.z, 24, [1, 0.9, 0.3], 4, 0.9);
        }
        break;
      }
      case 'shield': {
        const v = this.players.get(ev.id);
        if (v) this._burst(v.root.position.x, 0.6, v.root.position.z, 18, [0.4, 0.75, 1], 3.5, 0.6);
        break;
      }
      case 'kick': {
        for (const v of this.bombViews.values()) if (v.cx === ev.x && v.cy === ev.y) { v.pop = 0.0; }
        break;
      }
      default: break;
    }
  }

  setWinner(id) { this.celebrate = id ? { id, until: performance.now() + 4500, next: 0 } : null; }

  _spawnFlames(cells, origins, ms, total) {
    const originSet = new Set(origins.map(([x, y]) => y * this.cols + x));
    const now = performance.now();
    for (const [x, y] of cells) {
      const m = this.flameFree.pop();
      if (!m) break; // pool exhausted: skip decoration, gameplay is unaffected
      m.material = originSet.has(y * this.cols + x) ? this.mat.flameCenter : this.mat.flameArm;
      m.position.set(this.cellX(x) + 0.5, 0.3, this.cellZ(y) + 0.5);
      m.visible = true;
      this.flameActive.push({ m, t0: now - (total - ms), dur: total });
    }
  }

  _addBomb(b) {
    const G = this.geo, M = this.mat, sh = this.shadowsOn;
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x1d1d2b, flatShading: true, emissive: 0x000000 });
    const body = new THREE.Mesh(G.sphere, bodyMat); body.scale.set(0.74, 0.7, 0.74); body.position.y = 0.4; body.castShadow = sh;
    const cap = new THREE.Mesh(G.cyl, M.cap); cap.scale.set(0.2, 0.1, 0.2); cap.position.y = 0.78;
    const fuse = new THREE.Mesh(G.cyl, M.fuse); fuse.scale.set(0.05, 0.3, 0.05); fuse.position.y = 0.88;
    const spark = new THREE.Mesh(G.sphere, M.spark); spark.scale.set(0.16, 0.16, 0.16); spark.position.y = 1.05;
    const blob = new THREE.Mesh(G.circle, M.shadow); blob.position.y = 0.02; blob.scale.set(0.8, 1, 0.8);
    group.add(blob, body, cap, fuse, spark);
    group.position.set(this.cellX(b.x) + 0.5, 0, this.cellZ(b.y) + 0.5);
    group.scale.setScalar(0.01);
    this.dynamic.add(group);
    const v = { group, body, bodyMat, fuse, spark, cx: b.x, cy: b.y, left: b.l, at: performance.now(), born: performance.now(), pop: -1 };
    this.bombViews.set(b.id, v);
    return v;
  }

  _removeBomb(id, v) { this.dynamic.remove(v.group); v.bodyMat.dispose(); this.bombViews.delete(id); }

  _addPowerup(u) {
    const G = this.geo, M = this.mat;
    const group = new THREE.Group();
    const color = TYPE_COLORS[u.k] || 0xffffff;
    const base = new THREE.Mesh(G.cyl, M.baseDisc); base.scale.set(0.8, 0.06, 0.8); base.position.y = 0.04;
    const ringMat = new THREE.MeshBasicMaterial({ color });
    const ring = new THREE.Mesh(G.ring, ringMat); ring.position.y = 0.08; ring.scale.set(1.5, 1, 1.5);
    group.add(base, ring);
    const icon = new THREE.Group(); icon.position.y = 0.55;
    const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
    const add = (geo, sx, sy, sz, px = 0, py = 0, pz = 0, m = mat) => { const o = new THREE.Mesh(geo, m); o.scale.set(sx, sy, sz); o.position.set(px, py, pz); icon.add(o); return o; };
    switch (u.k) {
      case 'bomb': add(G.sphere, 0.48, 0.48, 0.48); add(G.cyl, 0.12, 0.2, 0.12, 0, 0.3, 0, M.fuse); add(G.box, 0.5, 0.1, 0.1, 0, 0.0, 0.26, M.white); add(G.box, 0.1, 0.5, 0.1, 0, 0.0, 0.26, M.white); break;
      case 'range': add(G.cone, 0.36, 0.6, 0.36, 0, 0.05); add(G.cone, 0.36, 0.45, 0.36, 0, -0.25).rotation.x = Math.PI; break;
      case 'speed': add(G.oct, 0.34, 0.7, 0.34); add(G.oct, 0.22, 0.45, 0.22, 0.12, -0.2, 0); break;
      case 'shield': add(G.ico, 0.62, 0.7, 0.3); break;
      case 'detonator': add(G.cyl, 0.5, 0.22, 0.5, 0, -0.1); add(G.cyl, 0.26, 0.2, 0.26, 0, 0.08, 0, M.white); break;
      case 'banana': { const o = new THREE.Mesh(G.banana, mat); o.scale.set(0.8, 0.8, 0.8); o.position.y = -0.3; icon.add(o); break; }
      case 'kick': add(G.box, 0.45, 0.3, 0.45, 0, -0.1); add(G.cone, 0.3, 0.4, 0.3, 0, 0.2).rotation.z = -Math.PI / 2; break;
      default: add(G.sphere, 0.4, 0.4, 0.4);
    }
    group.add(icon);
    group.position.set(this.cellX(u.x) + 0.5, 0, this.cellZ(u.y) + 0.5);
    this.dynamic.add(group);
    this.upViews.set(u.id, { group, icon, mats: [mat, ringMat], t: Math.random() * 6 });
  }

  // ------------------------------------------------------------------ particles

  _burst(x, y, z, n, rgb, speed, life) {
    const reduce = this.settings.reduceMotion;
    const count = reduce ? Math.ceil(n / 3) : n;
    for (let i = 0; i < count; i++) {
      const k = this.pIdx; this.pIdx = (this.pIdx + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.pPos[k * 3] = x; this.pPos[k * 3 + 1] = y; this.pPos[k * 3 + 2] = z;
      this.pVel[k * 3] = Math.cos(a) * s; this.pVel[k * 3 + 1] = e * s + 1.2; this.pVel[k * 3 + 2] = Math.sin(a) * s;
      this.pBase[k * 3] = rgb[0]; this.pBase[k * 3 + 1] = rgb[1]; this.pBase[k * 3 + 2] = rgb[2];
      this.pLife[k] = this.pMax[k] = life * (0.6 + Math.random() * 0.6);
    }
  }

  _updateParticles(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const l = this.pLife[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) { this.pLife[i] = 0; this.pPos[i * 3 + 1] = -100; this.pCol[i * 3] = this.pCol[i * 3 + 1] = this.pCol[i * 3 + 2] = 0; continue; }
      this.pLife[i] = nl;
      this.pVel[i * 3 + 1] -= 9 * dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt; this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt; this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      if (this.pPos[i * 3 + 1] < 0.02) { this.pPos[i * 3 + 1] = 0.02; this.pVel[i * 3 + 1] *= -0.3; }
      const f = nl / this.pMax[i];
      this.pCol[i * 3] = this.pBase[i * 3] * f; this.pCol[i * 3 + 1] = this.pBase[i * 3 + 1] * f; this.pCol[i * 3 + 2] = this.pBase[i * 3 + 2] * f;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------------ frame

  resize() {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const fov = this.camera.fov * DEG;
    const needV = Math.max(this.rows * 0.94 + 3.4, (this.cols + 2.6) / this.camera.aspect);
    this.camDist = needV / (2 * Math.tan(fov / 2));
    this.camera.updateProjectionMatrix();
  }

  _interpolate(now) {
    const n = this.snaps.length;
    if (n === 0) return null;
    const rt = now - SNAP_DELAY_MS;
    let a = this.snaps[0], b = null;
    for (let i = n - 1; i >= 0; i--) {
      if (this.snaps[i].at <= rt) { a = this.snaps[i]; b = this.snaps[i + 1] || null; break; }
    }
    const alpha = b ? Math.min(1, Math.max(0, (rt - a.at) / Math.max(1, b.at - a.at))) : 0;
    return { a: a.s, b: b ? b.s : null, alpha };
  }

  render(dt) {
    if (!this.hasMatch) return;
    dt = Math.min(dt, 0.1);
    const now = performance.now();
    const reduce = this.settings.reduceMotion;

    // adaptive resolution
    this.frameAvg += (dt * 1000 - this.frameAvg) * 0.05;
    if (++this.frameCount % 90 === 0) {
      if (this.frameAvg > 30 && this.dpr > 0.8) { this.dpr = Math.max(0.75, this.dpr - 0.25); this.resize(); }
    }

    // ---- players
    const it = this._interpolate(now);
    const latest = this.latest;
    if (it) {
      for (const v of this.players.values()) {
        const pa = it.a.p.find((q) => q.id === v.id);
        if (!pa) continue;
        const pb = it.b ? it.b.p.find((q) => q.id === v.id) : null;
        let tx = pb ? pa.x + (pb.x - pa.x) * it.alpha : pa.x;
        let ty = pb ? pa.y + (pb.y - pa.y) * it.alpha : pa.y;
        if (v.id === this.localId && latest) {
          const pl = latest.p.find((q) => q.id === v.id);
          if (pl) { tx = pl.x; ty = pl.y; }
        }
        const wx = this.cellX(tx), wz = this.cellZ(ty);
        const px = v.root.position.x, pz = v.root.position.z;
        if (!v.init || Math.hypot(wx - px, wz - pz) > 2.5) { v.root.position.x = wx; v.root.position.z = wz; v.init = true; }
        else {
          const k = v.id === this.localId ? 1 - Math.exp(-dt * 24) : 1;
          v.root.position.x += (wx - px) * k; v.root.position.z += (wz - pz) * k;
        }
        const moved = Math.hypot(v.root.position.x - px, v.root.position.z - pz) / Math.max(dt, 1e-3);
        v.moving = moved > 0.4;
        const pf = (latest || it.a).p.find((q) => q.id === v.id) || pa;
        if (pf.fx || pf.fy) {
          const target = Math.atan2(pf.fx, pf.fy);
          let d = target - v.yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
          v.yaw += d * (1 - Math.exp(-dt * 14));
        }
      }
    }
    for (const v of this.players.values()) this._animatePlayer(v, dt, now, reduce);

    // ---- bombs
    for (const v of this.bombViews.values()) {
      const left = Math.max(0, v.left - (now - v.at));
      const frac = Math.min(1, left / (this.cfg ? this.cfg.fuseMs : 2500));
      const age = (now - v.born) / 1000;
      const pop = Math.min(1, age * 7);
      const rate = 6 + (1 - frac) * 22;
      const pulse = 1 + 0.07 * Math.sin(age * rate) * (reduce ? 0.4 : 1);
      v.group.scale.setScalar(Math.max(0.01, (0.4 + 0.6 * easeOutBack(pop)) * pulse));
      const tx = this.cellX(v.cx) + 0.5, tz = this.cellZ(v.cy) + 0.5;
      v.group.position.x += (tx - v.group.position.x) * (1 - Math.exp(-dt * 20));
      v.group.position.z += (tz - v.group.position.z) * (1 - Math.exp(-dt * 20));
      v.fuse.scale.y = 0.08 + 0.3 * frac; v.fuse.position.y = 0.78 + v.fuse.scale.y * 0.5;
      v.spark.position.y = 0.78 + v.fuse.scale.y + 0.02;
      v.spark.scale.setScalar(0.12 + 0.07 * (0.5 + 0.5 * Math.sin(now * 0.05 + v.born)));
      const hot = left < 900 && Math.floor(now / 90) % 2 === 0;
      v.bodyMat.emissive.setHex(hot ? 0x7a1010 : 0x000000);
      if (left < 1000 && this.onTick) this.onTick();
    }

    // ---- power-ups, flames
    for (const u of this.upViews.values()) {
      u.t += dt;
      u.icon.position.y = 0.55 + (reduce ? 0 : Math.sin(u.t * 3) * 0.08);
      u.icon.rotation.y += dt * (reduce ? 0.6 : 2);
    }
    for (let i = this.flameActive.length - 1; i >= 0; i--) {
      const f = this.flameActive[i];
      const frac = (now - f.t0) / f.dur;
      if (frac >= 1) { f.m.visible = false; this.flameFree.push(f.m); this.flameActive.splice(i, 1); continue; }
      const grow = frac < 0.18 ? frac / 0.18 : 1 - ((frac - 0.18) / 0.82) * 0.75;
      f.m.scale.set(0.9 * (0.7 + 0.3 * grow), 0.12 + 0.62 * grow, 0.9 * (0.7 + 0.3 * grow));
      f.m.position.y = f.m.scale.y * 0.5;
    }
    // crate break animation
    for (let i = this.crateAnims.length - 1; i >= 0; i--) {
      const a = this.crateAnims[i];
      a.t += dt / 0.18;
      const s = Math.max(0, 1 - a.t);
      this._setCrateMatrices(a.i, this.cellX(a.x) + 0.5, this.cellZ(a.y) + 0.5, s < 0.02 ? 0.0001 : s);
      if (a.t >= 1) this.crateAnims.splice(i, 1);
    }
    // danger overlay pulse
    this.mat.danger.opacity = 0.22 + 0.12 * Math.sin(now * 0.008);
    this.mat.dangerHot.opacity = 0.45 + 0.2 * Math.sin(now * 0.02);

    // celebration confetti
    if (this.celebrate && now < this.celebrate.until && !reduce && now >= this.celebrate.next) {
      const v = this.players.get(this.celebrate.id);
      if (v) {
        const r = Math.random();
        this._burst(v.root.position.x, 1.5, v.root.position.z, 14, [r, 1 - r * 0.6, 0.4 + r * 0.5], 4, 1.4);
        this.celebrate.next = now + 140;
      }
    }

    this._updateParticles(dt);
    this._updateCamera(dt, now, reduce);
    this.renderer.render(this.scene, this.camera);
  }

  _animatePlayer(v, dt, now, reduce) {
    const celebrating = this.celebrate && this.celebrate.id === v.id && now < this.celebrate.until;
    if (v.dying >= 0) {
      v.dying += dt / 0.9;
      const s = Math.max(0.001, 1 - v.dying);
      v.root.scale.setScalar(s);
      v.root.rotation.y += dt * 14;
      v.root.position.y = Math.sin(Math.min(1, v.dying) * Math.PI) * 0.8;
      if (v.dying >= 1) { v.root.visible = false; v.dying = 99; }
      return;
    }
    if (!v.alive) { v.root.visible = false; return; }
    const rate = v.moving ? 12 : 3;
    v.phase += dt * rate;
    const amp = reduce ? 0.4 : 1;
    let bob = v.moving ? Math.abs(Math.sin(v.phase)) * 0.09 * amp : Math.sin(v.phase) * 0.015 * amp;
    if (celebrating) bob = Math.abs(Math.sin(now * 0.012)) * 0.5;
    v.root.position.y = bob;
    v.root.rotation.y = v.slip ? v.root.rotation.y + dt * 14 : (celebrating ? now * 0.006 : v.yaw);
    v.body.rotation.z = v.moving ? Math.sin(v.phase) * 0.12 * amp : 0;
    v.body.rotation.x = v.slip ? -0.5 : (v.moving ? 0.1 : 0);
    v.feet[0].position.z = 0.04 + (v.moving ? Math.sin(v.phase) * 0.14 : 0);
    v.feet[1].position.z = 0.04 + (v.moving ? -Math.sin(v.phase) * 0.14 : 0);
    if (v.shield.visible) v.shield.scale.setScalar(1.15 + Math.sin(now * 0.008) * 0.04);
    v.label.visible = true;
  }

  _updateCamera(dt, now, reduce) {
    const target = this._tmpTarget.set(0, 0, 0.3);
    const me = this.localId && this.players.get(this.localId);
    if (me && me.alive && me.init) { target.x = me.root.position.x * 0.12; target.z = 0.3 + me.root.position.z * 0.1; }
    this.camTarget.lerp(target, 1 - Math.exp(-dt * 3));
    const el = 63 * DEG;
    const d = this.camDist;
    let sx = 0, sy = 0;
    if (this.shake > 0.001) {
      if (this.settings.shake && !reduce) { sx = (Math.random() - 0.5) * this.shake * 0.35; sy = (Math.random() - 0.5) * this.shake * 0.25; }
      this.shake *= Math.exp(-dt * 7);
    }
    this.camera.position.set(this.camTarget.x + sx, this.camTarget.y + d * Math.sin(el) + sy, this.camTarget.z + d * Math.cos(el));
    this.camera.lookAt(this.camTarget);
    this.sun.position.set(6, 16, 9);
  }

  dispose() {
    this.clearMatch();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    this.particles.geometry.dispose(); this.particles.material.dispose();
    this.renderer.dispose();
  }
}

function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
