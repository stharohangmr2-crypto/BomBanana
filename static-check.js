'use strict';
// Static consistency checks: files exist, JS parses, HTML ids used by JS exist, socket events match, deps declared.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failed++; console.log(`  FAIL ${m}`); };

// 1. required files
for (const f of ['package.json', 'server.js', 'src/config.js', 'src/game.js', 'src/rooms.js', 'public/index.html', 'public/style.css',
  'public/js/main.js', 'public/js/scene.js', 'public/js/input.js', 'public/js/audio.js', 'README.md', '.env.example']) {
  fs.existsSync(path.join(root, f)) ? ok(`exists ${f}`) : bad(`missing ${f}`);
}

// 2. package.json + dependencies
const pkg = JSON.parse(read('package.json'));
ok('package.json parses');
for (const d of ['express', 'socket.io', 'three']) pkg.dependencies[d] ? ok(`dependency ${d}`) : bad(`dependency ${d} missing`);
pkg.scripts.start === 'node server.js' ? ok('start script') : bad('start script');

// 3. JS parses
for (const f of ['server.js', 'src/config.js', 'src/game.js', 'src/rooms.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(root, f)]); ok(`parses ${f}`); } catch (e) { bad(`parse ${f}`); }
}
for (const f of fs.readdirSync(path.join(root, 'public/js'))) {
  try { execFileSync(process.execPath, ['--input-type=module', '--check'], { input: read(`public/js/${f}`) }); ok(`parses (module) public/js/${f}`); } catch (e) { bad(`parse public/js/${f}`); }
}

// 4. HTML ids referenced from JS exist
const html = read('public/index.html');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set();
for (const f of ['main.js']) for (const m of read(`public/js/${f}`).matchAll(/\$\('([^']+)'\)/g)) used.add(m[1]);
for (const m of read('public/js/main.js').matchAll(/\$\(`([a-z]+)-\$\{/g)) { /* dynamic screen ids checked below */ }
for (const s of ['menu', 'lobby', 'game', 'results']) used.add(`screen-${s}`);
for (const id of used) ids.has(id) ? null : bad(`HTML id missing: #${id}`);
ok(`${used.size} element ids referenced by main.js all exist`);
const dupes = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) !== i);
dupes.length ? bad(`duplicate ids ${dupes}`) : ok('no duplicate ids');
const inputIds = [...read('public/js/main.js').matchAll(/(?:controls|zone|base|knob|bomb|det|trap): \$\('([^']+)'\)/g)];
// CSS ids used
const css = read('public/style.css');
for (const m of css.matchAll(/#([a-z][a-z0-9-]*)/gi)) if (!/^[0-9a-f]{3,8}$/i.test(m[1]) && !ids.has(m[1])) bad(`CSS references missing id #${m[1]}`);
ok('CSS id selectors all exist in HTML');

// 5. socket events: client emits must be handled by server, server emits must be handled by client
const server = read('server.js'), rooms = read('src/rooms.js'), main = read('public/js/main.js');
const serverHandles = new Set([...server.matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1]));
const clientEmits = new Set([...main.matchAll(/(?:emit|emitAck)\('([^']+)'/g)].map((m) => m[1]));
for (const e of clientEmits) serverHandles.has(e) ? null : bad(`client emits "${e}" but server has no handler`);
ok(`client emits (${[...clientEmits].join(', ')}) all handled by server`);
const serverEmits = new Set([...rooms.matchAll(/emit\('([^']+)'/g)].map((m) => m[1]));
const clientHandles = new Set([...main.matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1]));
for (const e of serverEmits) clientHandles.has(e) ? null : bad(`server emits "${e}" but client has no handler`);
ok(`server emits (${[...serverEmits].join(', ')}) all handled by client`);
// 6. local asset references in HTML exist
for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
  const u = m[1];
  if (u.startsWith('/socket.io/') || u.startsWith('/vendor/')) continue;
  fs.existsSync(path.join(root, 'public', u)) ? ok(`asset ${u}`) : bad(`missing asset ${u}`);
}
// 7. client modules: relative imports resolve
for (const f of fs.readdirSync(path.join(root, 'public/js'))) for (const m of read(`public/js/${f}`).matchAll(/from '(\.\/[^']+)'/g)) fs.existsSync(path.join(root, 'public/js', m[1])) ? null : bad(`${f} imports missing ${m[1]}`);
ok('relative imports resolve');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll static checks passed');
process.exit(failed ? 1 : 0);
