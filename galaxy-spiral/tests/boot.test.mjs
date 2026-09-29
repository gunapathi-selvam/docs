// Boots src/js/main.js against a fake DOM built from index.html and drives its
// real animation loop. Catches wiring errors between script and markup that
// pure-math tests cannot see.
import { boot, ctxCalls } from './harness.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails++; };
const section = (s) => console.log('\n--- ' + s);

const errs = [];
process.on('uncaughtException', (e) => errs.push(e));

section('boot');
let bootError = null;
let ctx;
try { ctx = await boot(); } catch (e) { bootError = e; }
ok(!bootError, 'main.js loads without throwing' + (bootError ? ': ' + bootError.message : ''));
if (bootError) { console.error(bootError); process.exit(1); }

const { byId, body, pump, winListeners } = ctx;
const HTMLInputElement = globalThis.HTMLInputElement;

section('render loop');
pump(90);
ok(errs.length === 0, 'runs 90 frames clean' + (errs[0] ? ': ' + errs[0].message : ''));
// Dots start scattered wide and are culled off-screen while they fly in, so
// measure the settled steady state rather than the warm-up.
const warm = ctxCalls.arc;
pump(30);
ok((ctxCalls.arc - warm) / 30 > 985,
  `settled loop draws the full field every frame (${((ctxCalls.arc - warm) / 30).toFixed(1)}/1000 dots)`);
ok(ctxCalls.bad === 0, `no NaN or non-positive geometry reached the canvas (${ctxCalls.bad} bad)`);

section('HUD wiring');
const hudShape = byId.get('hud-shape');
ok(hudShape.textContent === 'Galaxy Spiral', `shows the default shape ("${hudShape.textContent}")`);
ok(byId.get('hud-fps').textContent.endsWith('fps'), `reports fps ("${byId.get('hud-fps').textContent}")`);
ok(byId.get('hud-gesture').textContent.length > 0, `reports gesture ("${byId.get('hud-gesture').textContent}")`);
ok(byId.get('status-text').textContent === 'camera off', `status starts off ("${byId.get('status-text').textContent}")`);

section('shape chips');
const chips = byId.get('shape-list').children;
ok(chips.length === 8, `all 8 chips rendered (${chips.length})`);
ok(chips.some((c) => c.classList.contains('is-active')), 'active chip is highlighted');
chips[3].click();
pump(3);
ok(hudShape.textContent === 'Cube', `clicking a chip switches shape ("${hudShape.textContent}")`);
ok(chips[3].classList.contains('is-active') && !chips[0].classList.contains('is-active'),
  'highlight follows the active shape');

section('keyboard');
const key = (k) => winListeners.keydown({ key: k, target: body, preventDefault() {} });
key('6'); pump(2);
ok(hudShape.textContent === 'Galaxy Spiral', `key 6 -> Galaxy Spiral ("${hudShape.textContent}")`);
key('1'); pump(2);
ok(hudShape.textContent === 'Core', `key 1 -> Core ("${hudShape.textContent}")`);
key('8'); pump(2);
ok(hudShape.textContent === 'Wave Field', `key 8 -> Wave Field ("${hudShape.textContent}")`);
key('9'); pump(2);
ok(hudShape.textContent === 'Wave Field', 'out-of-range key 9 is ignored');

const trailsBtn = byId.get('btn-trails');
key('t');
ok(trailsBtn.getAttribute('aria-pressed') === 'false', 'key T toggles trails off');
key('t');
ok(trailsBtn.getAttribute('aria-pressed') === 'true', 'key T toggles trails back on');
key('h');
ok(body.classList.contains('ui-hidden'), 'key H hides the UI');
key('h');
ok(!body.classList.contains('ui-hidden'), 'key H restores the UI');

const before = ctxCalls.arc;
key(' '); pump(20);
ok(ctxCalls.arc - before > 15000, 'Space bursts and the loop keeps drawing');

key('2'); pump(2);
const shapeAfter = hudShape.textContent;
winListeners.keydown({ key: '5', target: new HTMLInputElement(), preventDefault() {} });
pump(2);
ok(hudShape.textContent === shapeAfter, 'keys are ignored while typing in an input');

section('camera failure');
byId.get('btn-camera').click();
await new Promise((r) => setTimeout(r, 30));
ok(byId.get('status-text').textContent === 'no camera found',
  `a missing camera is reported cleanly ("${byId.get('status-text').textContent}")`);
ok(byId.get('status-dot').dataset.state === 'error', 'status dot flags the error state');
pump(10);
ok(errs.length === 0, 'loop survives a failed camera start');

section('resize');
globalThis.window.innerWidth = 800;
globalThis.window.innerHeight = 600;
winListeners.resize();
const sc = byId.get('scene');
ok(sc.width === 1600 && sc.height === 1200, `backing store follows dpr (${sc.width}x${sc.height})`);
ok(sc.style.width === '800px', `css size follows viewport (${sc.style.width})`);
pump(10);
ok(errs.length === 0, 'loop survives a resize');

section('pointer fallback');
const arcsBefore = ctxCalls.arc;
sc.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
sc.dispatch('pointermove', { clientX: 260, clientY: 150, pointerId: 1 });
sc.dispatch('pointerup', { pointerId: 1 });
sc.dispatch('wheel', { deltaY: -120, preventDefault() {} });
pump(10);
ok(errs.length === 0, 'drag and wheel fallback run clean');
ok(ctxCalls.arc > arcsBefore, 'still rendering after pointer input');

console.log(fails ? `\n${fails} FAILING\n` : '\nAll checks passed.\n');
process.exit(fails ? 1 : 0);
