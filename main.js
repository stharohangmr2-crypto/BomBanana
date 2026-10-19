import { GameScene } from './scene.js';
import { Controls } from './input.js';
import { AudioFX } from './audio.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- settings
const SETTINGS_KEY = 'bb3d.settings';
const settings = Object.assign(
  { sound: true, shake: true, reduceMotion: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches, quality: 'auto' },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } })(),
);
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage may be blocked */ } }
function applySettingsToUi() {
  $('set-sound').checked = settings.sound;
  $('set-shake').checked = settings.shake;
  $('set-motion').checked = settings.reduceMotion;
  $('set-quality').value = settings.quality;
  document.body.classList.toggle('reduce-motion', settings.reduceMotion);
}
applySettingsToUi();
$('set-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; saveSettings(); audio.unlock(); audio.ui(); });
$('set-shake').addEventListener('change', (e) => { settings.shake = e.target.checked; saveSettings(); });
$('set-motion').addEventListener('change', (e) => { settings.reduceMotion = e.target.checked; saveSettings(); applySettingsToUi(); });
$('set-quality').addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); toast('Graphics quality applies from the next match.'); });

const audio = new AudioFX(settings);
for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, () => audio.unlock(), { passive: true });

// ---------------------------------------------------------------- state
const SESSION_KEY = 'bb3d.session';
const S = {
  screen: 'menu', me: null, code: null, room: null, scene: null, inMatch: false, matchActive: false,
  localAlive: true, lastCount: -1, wentActive: false, results: null, resultsTimer: null, running: false,
  lastResync: 0, ended: false, ping: null, everConnected: false, pending: false,
};
const fatal = (msg) => { const f = $('fatal'); f.textContent = msg; f.hidden = false; };
if (typeof io === 'undefined') fatal('Could not load the multiplayer library. Open this game from the server\'s web address and check your connection.');

const socket = typeof io === 'undefined' ? null : io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });

// ---------------------------------------------------------------- small UI helpers
function showScreen(name) {
  S.screen = name;
  for (const id of ['menu', 'lobby', 'game', 'results']) $(`screen-${id}`).classList.toggle('active', id === name);
  if (name === 'game') startLoop();
  syncControls();
}
let toastTimer = null;
function toast(msg, bad = false, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.classList.toggle('bad', bad); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
let bannerTimer = null;
function banner(msg, ms = 2200) {
  const b = $('banner'); b.textContent = msg; b.hidden = false;
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
}
let centerTimer = null;
function center(msg, { ms = 0, small = false } = {}) {
  const c = $('overlay-center');
  c.textContent = msg; c.classList.toggle('small-text', small); c.hidden = false;
  clearTimeout(centerTimer);
  if (ms) centerTimer = setTimeout(() => { c.hidden = true; }, ms);
}
const hideCenter = () => { $('overlay-center').hidden = true; clearTimeout(centerTimer); };
function setStatus(kind, text) {
  for (const id of ['menu-status', 'lobby-status']) { const el = $(id); el.classList.remove('ok', 'bad', 'wait'); el.classList.add(kind); }
  $('menu-status-text').textContent = text; $('lobby-status-text').textContent = text;
  const net = $('hud-net'); net.classList.remove('ok', 'bad', 'wait'); net.classList.add(kind);
}
function menuError(msg) { const e = $('menu-error'); e.textContent = msg || ''; e.hidden = !msg; }
const modals = ['modal-howto', 'modal-settings', 'modal-menu'];
function openModal(id) { for (const m of modals) $(m).hidden = m !== id; syncControls(); }
function closeModals() { for (const m of modals) $(m).hidden = true; syncControls(); }
const modalOpen = () => modals.some((m) => !$(m).hidden);
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, 9999);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- session persistence (for reconnecting mid-match)
function saveSession() { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: S.code, id: S.me.id, token: S.me.token })); } catch (e) { /* ignore */ } }
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } }

// ---------------------------------------------------------------- controls
const controls = new Controls(
  { controls: $('controls'), zone: $('joy-zone'), base: $('joy-base'), knob: $('joy-knob'), bomb: $('btn-bomb'), det: $('btn-det'), trap: $('btn-trap') },
  { move: onMove, bomb: () => act('game:bomb'), detonate: () => act('game:detonate'), trap: () => act('game:trap') },
);
let cur = { dx: 0, dy: 0 }, lastSent = { dx: 0, dy: 0, at: 0 }, flushTimer = null;
function canPlay() { return !!(socket && socket.connected && S.inMatch && S.matchActive && S.localAlive && !modalOpen()); }
function onMove(dx, dy) { cur = { dx, dy }; flushInput(); }
function flushInput() {
  if (!canPlay() && (cur.dx !== 0 || cur.dy !== 0)) { if (lastSent.dx === 0 && lastSent.dy === 0) return; }
  const now = performance.now();
  if (now - lastSent.at < 33) { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushInput(); }, 34); return; }
  const dx = canPlay() ? cur.dx : 0, dy = canPlay() ? cur.dy : 0;
  if (dx === lastSent.dx && dy === lastSent.dy) return;
  lastSent = { dx, dy, at: now };
  if (socket && socket.connected) socket.emit('game:input', { dx, dy });
}
setInterval(() => { // keep-alive so the server does not time out a held direction
  if (canPlay() && (cur.dx || cur.dy) && socket.connected) { lastSent.at = performance.now(); socket.emit('game:input', { dx: cur.dx, dy: cur.dy }); }
}, 250);
function act(ev) { if (canPlay()) socket.emit(ev); }
function syncControls() {
  const on = S.screen === 'game' && S.inMatch && S.matchActive && S.localAlive && !modalOpen();
  controls.setEnabled(on);
  if (!on) { cur = { dx: 0, dy: 0 }; flushInput(); }
}

// ---------------------------------------------------------------- game loop
let lastFrame = 0;
function startLoop() {
  if (S.running) return;
  S.running = true; lastFrame = performance.now();
  const loop = (t) => {
    if (S.screen !== 'game') { S.running = false; return; }
    const dt = (t - lastFrame) / 1000; lastFrame = t;
    if (S.scene) S.scene.render(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
function onResize() { if (S.scene) S.scene.resize(); }
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

// ---------------------------------------------------------------- networking
function emitAck(ev, data, cb) {
  if (!socket) return;
  socket.timeout(6000).emit(ev, data, (err, res) => {
    if (err) { cb({ ok: false, error: 'The server did not answer. Check your connection and try again.' }); return; }
    cb(res || { ok: false, error: 'Unexpected reply from the server.' });
  });
}

if (socket) {
  socket.on('connect', () => {
    setStatus('ok', 'Connected');
    $('conn-banner').hidden = true;
    const wasReconnect = S.everConnected;
    S.everConnected = true;
    const sess = loadSession();
    if (sess && (wasReconnect || S.screen === 'menu')) {
      emitAck('session:resume', sess, (res) => {
        if (res.ok) {
          S.me = res.you; S.code = res.code; S.room = res.room; saveSession();
          if (wasReconnect) toast('Reconnected');
          if (res.room.phase === 'lobby') { renderLobby(); showScreen('lobby'); }
        } else {
          clearSession();
          if (wasReconnect) { toast('Could not rejoin your match. It may have ended.', true, 4000); leaveToMenu(); }
        }
      });
    }
  });
  socket.on('disconnect', () => {
    setStatus('bad', 'Disconnected, reconnecting…');
    if (S.me) $('conn-banner').hidden = false;
    cur = { dx: 0, dy: 0 };
  });
  socket.on('connect_error', () => { setStatus('bad', 'Cannot reach the server. Retrying…'); });
  socket.io.on('reconnect_attempt', () => setStatus('wait', 'Reconnecting…'));
  socket.on('session:replaced', () => { clearSession(); toast('This game was opened somewhere else.', true, 4000); leaveToMenu(); });

  socket.on('room:update', (room) => {
    S.room = room;
    if (!S.me) return;
    if (room.phase === 'lobby') {
      if (S.inMatch) { exitMatch(); }
      renderLobby();
      if (S.screen !== 'lobby') showScreen('lobby');
    } else if (room.phase === 'ended') {
      renderResultsButtons();
    }
    if (S.screen === 'game') updateHudPlayers();
  });
  socket.on('match:start', enterMatch);
  socket.on('game:state', enterMatch);
  socket.on('game:snapshot', onSnapshot);
  socket.on('match:end', onMatchEnd);

  setInterval(() => {
    if (!socket.connected) return;
    const t0 = performance.now();
    socket.timeout(2500).emit('net:ping', (err) => {
      if (err) return;
      S.ping = Math.round(performance.now() - t0);
      $('hud-net-text').textContent = `${S.ping} ms`;
      setStatus(S.ping > 400 ? 'wait' : 'ok', S.ping > 400 ? `Slow connection (${S.ping} ms)` : 'Connected');
    });
  }, 3000);
}

// ---------------------------------------------------------------- menu actions
const nickInput = $('nick-input'), codeInput = $('code-input');
try { nickInput.value = localStorage.getItem('bb3d.nick') || ''; } catch (e) { /* ignore */ }
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) codeInput.value = urlRoom.toUpperCase().slice(0, 4);
codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });

function nick() {
  const n = nickInput.value.trim().replace(/\s+/g, ' ').slice(0, 12);
  try { localStorage.setItem('bb3d.nick', n); } catch (e) { /* ignore */ }
  return n || 'Monkey';
}
function afterJoin(res) {
  S.pending = false; $('btn-create').disabled = false; $('btn-join').disabled = false;
  if (!res.ok) { menuError(res.error || 'Could not join.'); return; }
  menuError('');
  S.me = res.you; S.code = res.code; S.room = res.room; saveSession();
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  renderLobby(); showScreen('lobby');
}
$('btn-create').addEventListener('click', () => {
  if (S.pending) return;
  audio.unlock(); audio.ui();
  if (!socket || !socket.connected) { menuError('Not connected to the server yet. Wait for the green status and try again.'); return; }
  S.pending = true; $('btn-create').disabled = true; $('btn-join').disabled = true; menuError('');
  emitAck('room:create', { nick: nick() }, afterJoin);
});
$('btn-join').addEventListener('click', () => {
  if (S.pending) return;
  audio.unlock(); audio.ui();
  const code = codeInput.value.trim();
  if (code.length !== 4) { menuError('Enter the 4-character room code your friend shared.'); return; }
  if (!socket || !socket.connected) { menuError('Not connected to the server yet. Wait for the green status and try again.'); return; }
  S.pending = true; $('btn-create').disabled = true; $('btn-join').disabled = true; menuError('');
  emitAck('room:join', { code, nick: nick() }, afterJoin);
});
$('btn-howto').addEventListener('click', () => openModal('modal-howto'));
$('btn-settings').addEventListener('click', () => openModal('modal-settings'));
for (const b of document.querySelectorAll('.modal-close')) b.addEventListener('click', closeModals);

// ---------------------------------------------------------------- lobby
const isHost = () => !!(S.room && S.me && S.room.hostId === S.me.id);
function renderLobby() {
  const r = S.room; if (!r) return;
  $('lobby-code').textContent = r.code;
  $('lobby-count').textContent = `${r.players.length}/${r.max}`;
  const ul = $('lobby-players'); ul.innerHTML = '';
  for (const p of r.players) {
    const li = document.createElement('li');
    if (S.me && p.id === S.me.id) li.classList.add('me');
    li.innerHTML = `<i class="swatch" style="background:${esc(p.color)}"></i><span class="name">${esc(p.nick)}${S.me && p.id === S.me.id ? ' (you)' : ''}</span>`
      + (p.id === r.hostId ? '<span class="tag host">Host</span>' : '')
      + (p.connected ? (p.ready && p.id !== r.hostId ? '<span class="tag ready">Ready</span>' : '') : '<span class="tag off">Offline</span>');
    ul.appendChild(li);
  }
  const host = isHost();
  const me = r.players.find((p) => S.me && p.id === S.me.id);
  const others = r.players.filter((p) => p.id !== r.hostId);
  const allReady = others.every((p) => p.ready);
  $('btn-start').hidden = !host;
  $('btn-ready').hidden = host;
  if (host) {
    $('btn-start').disabled = !(r.players.length >= 2 && allReady);
    $('lobby-hint').textContent = r.players.length < 2 ? 'Share the code. You need at least 2 players.' : (allReady ? 'Everyone is ready. Start when you like.' : 'Waiting for everyone to press Ready…');
  } else {
    $('btn-ready').textContent = me && me.ready ? 'Not ready' : 'Ready';
    $('lobby-hint').textContent = me && me.ready ? 'Waiting for the host to start…' : 'Press Ready when you are set.';
  }
}
$('btn-ready').addEventListener('click', () => {
  audio.ui();
  const me = S.room.players.find((p) => p.id === S.me.id);
  emitAck('room:ready', { ready: !(me && me.ready) }, (res) => { if (!res.ok) toast(res.error, true); });
});
$('btn-start').addEventListener('click', () => {
  audio.unlock(); audio.ui();
  emitAck('room:start', {}, (res) => { if (!res.ok) toast(res.error, true); });
});
$('btn-leave').addEventListener('click', leaveRoom);
$('btn-copy-code').addEventListener('click', async () => {
  const ok = await copyText(S.code);
  toast(ok ? `Room code ${S.code} copied` : 'Could not copy. Press and hold the code to copy it.', !ok);
});
$('btn-copy-link').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${S.code}`;
  const ok = await copyText(url);
  toast(ok ? 'Invite link copied' : `Could not copy. Share this link: ${url}`, !ok, ok ? 2600 : 6000);
});

function leaveRoom() {
  if (socket && socket.connected) socket.emit('room:leave', {});
  leaveToMenu();
}
function leaveToMenu() {
  clearSession();
  S.me = null; S.code = null; S.room = null; S.results = null;
  clearTimeout(S.resultsTimer);
  exitMatch();
  closeModals();
  $('conn-banner').hidden = true;
  showScreen('menu');
}

// ---------------------------------------------------------------- match
function enterMatch(payload) {
  if (!S.me) return;
  try {
    if (!S.scene) {
      S.scene = new GameScene($('gl'), settings);
      S.scene.onTick = () => audio.tick();
    }
  } catch (e) {
    console.error(e);
    fatal('Your browser could not start 3D graphics (WebGL). Try updating your browser or turning off battery saver.');
    return;
  }
  clearTimeout(S.resultsTimer);
  S.results = null; S.ended = false;
  showScreen('game');
  S.scene.resize();
  S.scene.setup(payload, S.me.id);
  S.inMatch = true; S.matchActive = payload.snap.ph === 'active'; S.localAlive = true; S.wentActive = S.matchActive; S.lastCount = -1;
  S.players = payload.players;
  hideCenter(); $('banner').hidden = true; $('spectate').hidden = true;
  closeModals();
  buildHudPlayers();
  applySnapshotToHud(payload.snap);
  syncControls();
}
function exitMatch() {
  S.inMatch = false; S.matchActive = false;
  if (S.scene) S.scene.clearMatch();
  hideCenter();
  syncControls();
}

function onSnapshot(snap) {
  if (!S.inMatch || !S.scene) return;
  S.scene.pushSnapshot(snap);
  // synchronise crate count: if we missed a crate event, ask for a full state (rate limited)
  if (snap.cr !== S.scene.crateCount && performance.now() - S.lastResync > 2500) {
    S.lastResync = performance.now(); socket.emit('state:request', {});
  }
  // phase handling
  if (snap.ph === 'countdown') {
    const n = Math.ceil(snap.cd / 1000);
    if (n !== S.lastCount && n > 0) { S.lastCount = n; center(String(n)); audio.beep(false); }
  } else if (snap.ph === 'active' && !S.wentActive) {
    S.wentActive = true; S.matchActive = true; center('GO!', { ms: 800 }); audio.beep(true); syncControls();
  }
  let crateSound = false;
  for (const ev of snap.ev || []) {
    S.scene.handleEvent(ev);
    switch (ev.t) {
      case 'bomb': audio.place(); break;
      case 'boom': audio.explosion(); break;
      case 'crate': crateSound = true; break;
      case 'pickup': if (ev.p === S.me.id) { audio.pickup(); banner(`Power-up: ${POWER_NAMES[ev.k] || ev.k}`, 1400); } break;
      case 'shield': audio.shield(); if (ev.id === S.me.id) banner('Shield absorbed the blast!', 1600); break;
      case 'slip': audio.slip(); break;
      case 'kick': audio.kick(); break;
      case 'elim': onElim(ev); break;
      default: break;
    }
  }
  if (crateSound) audio.crate();
  applySnapshotToHud(snap);
}
const POWER_NAMES = { bomb: 'Extra bomb', range: 'Bigger blast', speed: 'Speed boost', shield: 'Shield', detonator: 'Remote detonator', banana: 'Banana peel', kick: 'Bomb kick' };

function nameOf(id) { const p = (S.players || []).find((q) => q.id === id); return p ? p.nick : 'Someone'; }
function onElim(ev) {
  audio.elim();
  if (ev.id === S.me.id) {
    S.localAlive = false; syncControls();
    $('spectate').hidden = false;
    banner(ev.r === 'blast' ? 'You were blasted! Now spectating.' : 'You are out. Now spectating.', 3000);
  } else {
    const why = ev.r === 'disconnect' ? ' lost connection' : (ev.r === 'left' ? ' left the match' : ' is out');
    banner(`${nameOf(ev.id)}${why}`, 2200);
  }
}

// ---------------------------------------------------------------- HUD
function buildHudPlayers() {
  const box = $('hud-players'); box.innerHTML = '';
  for (const p of S.players) {
    const d = document.createElement('div'); d.className = 'hud-chip'; d.dataset.id = p.id;
    d.innerHTML = `<i style="background:${esc(p.color)}"></i><span>${esc(p.nick)}${p.id === S.me.id ? ' (you)' : ''}</span>`;
    box.appendChild(d);
  }
}
function updateHudPlayers() { /* chip state is driven by snapshots */ }
function fmtTime(ms) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function applySnapshotToHud(snap) {
  $('hud-timer').textContent = fmtTime(snap.tl);
  $('hud-timer').classList.toggle('low', snap.ph === 'active' && snap.tl < 30000);
  let alive = 0;
  for (const p of snap.p) {
    if (p.a) alive++;
    const chip = document.querySelector(`.hud-chip[data-id="${p.id}"]`);
    if (chip) { chip.classList.toggle('dead', !p.a); chip.classList.toggle('off', !p.c && !!p.a); }
  }
  $('hud-alive').textContent = `${alive} alive`;
  const me = snap.p.find((p) => p.id === S.me.id);
  if (!me) return;
  $('stat-bombs').textContent = `Bombs ${Math.max(0, me.mb - me.bc)}/${me.mb}`;
  $('stat-range').textContent = `Range ${me.rg}`;
  const fx = [];
  if (me.sp > 0) fx.push(`Speed ${Math.ceil(me.sp / 1000)}s`);
  if (me.sh) fx.push('Shield');
  if (me.det > 0) fx.push(`Boom x${me.det}`);
  if (me.tr > 0) fx.push(`Peel x${me.tr}`);
  if (me.kk) fx.push('Kick');
  const key = fx.join('|');
  const el = $('stat-effects');
  if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = fx.map((t) => `<span class="chip fx">${esc(t)}</span>`).join(''); }
  controls.setAvailability({ det: me.det > 0 && !!me.a, trap: me.tr > 0 && !!me.a });
  if (!me.a && S.localAlive) { S.localAlive = false; $('spectate').hidden = false; syncControls(); }
}

$('btn-menu').addEventListener('click', () => { audio.ui(); openModal('modal-menu'); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.screen === 'game') { if (modalOpen()) closeModals(); else openModal('modal-menu'); }
});
$('btn-resume').addEventListener('click', closeModals);
$('btn-menu-settings').addEventListener('click', () => openModal('modal-settings'));
$('btn-menu-howto').addEventListener('click', () => openModal('modal-howto'));
$('btn-menu-leave').addEventListener('click', () => { if (confirm('Leave the match? You will be eliminated.')) leaveRoom(); });
// Closing settings/how-to from the in-game menu returns to the game, which keeps running.

// ---------------------------------------------------------------- results
function onMatchEnd(result) {
  if (!S.me) return;
  S.results = result; S.ended = true; S.matchActive = false; syncControls();
  const winner = result.winnerId;
  if (S.scene && S.inMatch) S.scene.setWinner(winner);
  if (winner) {
    const mine = winner === S.me.id;
    center(mine ? 'You win!' : `${nameOf(winner)} wins!`, { small: !mine });
    mine ? audio.win() : audio.lose();
  } else {
    center('Draw!');
    audio.lose();
  }
  clearTimeout(S.resultsTimer);
  S.resultsTimer = setTimeout(showResults, 3800);
}
function showResults() {
  const r = S.results; if (!r) return;
  hideCenter();
  const winner = r.standings.find((s) => s.id === r.winnerId);
  $('result-title').textContent = winner ? (winner.id === S.me.id ? 'You win!' : `${winner.nick} wins!`) : 'Draw';
  const why = { last_standing: 'Last banana standing.', all_eliminated: 'Everyone went out at the same time.', time_up: 'Time ran out with several players alive.' }[r.reason] || '';
  $('result-sub').textContent = `${why} Match length ${fmtTime(r.durationMs)}.`;
  const ol = $('result-list'); ol.innerHTML = '';
  for (const s of r.standings) {
    const li = document.createElement('li');
    if (s.id === r.winnerId) li.classList.add('win');
    const tie = r.drawIds.includes(s.id) && !r.winnerId;
    li.innerHTML = `<span class="rank">${s.rank}</span><i class="swatch" style="background:${esc(s.color)}"></i><span class="name">${esc(s.nick)}${s.id === S.me.id ? ' (you)' : ''}</span><span class="meta">${s.kills} KO${s.kills === 1 ? '' : 's'}${tie ? ' · draw' : ''}</span>`;
    ol.appendChild(li);
  }
  renderResultsButtons();
  showScreen('results');
}
function renderResultsButtons() {
  const host = isHost();
  $('btn-rematch').hidden = !host; $('btn-lobby').hidden = !host; $('results-wait').hidden = host;
  if (S.room) $('btn-rematch').disabled = S.room.players.length < 2;
}
$('btn-rematch').addEventListener('click', () => emitAck('room:rematch', {}, (res) => { if (!res.ok) toast(res.error, true); }));
$('btn-lobby').addEventListener('click', () => emitAck('room:lobby', {}, (res) => { if (!res.ok) toast(res.error, true); }));
$('btn-results-leave').addEventListener('click', leaveRoom);

setStatus('wait', 'Connecting…');
