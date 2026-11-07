// Drives the real kban binary and the real UI in headless Chromium over CDP.
// Each step runs its own hub on its own port. All read one registry, so each
// hub lists every board registered so far.
// usage: bun web/e2e/check.mjs <kban binary> [only-step]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const [bin, only] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kban-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

// --- processes ---------------------------------------------------------------
const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill('SIGKILL')));

// A fake xdg-open logs the tabs a hub opens, and a failing tailscale keeps
// every hub off the tailnet, so none pushes to the owner's phone.
const fakes = path.join(dir, 'bin');
const opened = path.join(dir, 'opened.log');
fs.mkdirSync(fakes);
fs.writeFileSync(path.join(fakes, 'xdg-open'), `#!/bin/sh\necho "$1" >> ${opened}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakes, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const tabsOpened = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').split('\n').filter(Boolean) : []);
const env = { ...process.env, XDG_CONFIG_HOME: dir, PATH: `${fakes}:${process.env.PATH}` };
async function server(file, port, open = false, e = env) {
  const p = spawn(bin, [...(open ? [] : ['-no-open']), '-p', String(port), file], { stdio: ['ignore', 'pipe', 'inherit'], env: e });
  procs.push(p);
  let out = '';
  return new Promise((r) => p.stdout.on('data', (d) => { out += d; const url = out.match(/^http\S+$/m); if (url) r(url[0]); }));
}
// kban FILE with a hub already on port: it registers FILE and exits.
function join(file, port, e = env) {
  const k = spawnSync(bin, ['-no-open', '-p', String(port), file], { env: e, encoding: 'utf8' });
  return { ok: k.status === 0, url: k.stdout.trim().split('\n').at(-1), id: k.stdout.trim().split('/').at(-1) };
}
const kban = (...args) => spawnSync(bin, args, { encoding: 'utf8' }).status === 0;
const entry = (id) => `#side .item[data-id="${id}"]`;
const dot = (id) => `!!document.querySelector('${entry(id)} .dot')`;

const chrome = spawn('chromium', ['--headless=new', '--remote-debugging-port=9339', `--user-data-dir=${dir}/profile`,
  '--window-size=1440,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
procs.push(chrome);

async function tab(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:9339/json/new?${url}`, { method: 'PUT' })).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      let id = 0;
      const wait = new Map();
      const handlers = [];
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && wait.has(msg.id)) { wait.get(msg.id)(msg); wait.delete(msg.id); }
        if (msg.method) handlers.forEach((h) => h(msg));
      };
      const send = (method, params = {}) => new Promise((r) => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
      const ev = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(`${expr}: ${JSON.stringify(r.result.exceptionDetails.exception?.description)}`);
        return r.result?.result?.value;
      };
      const KEYS = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
      const key = async (k, mods = {}) => {
        const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
        const single = k.length === 1;
        const base = { key: k, code: single ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: single ? k.toUpperCase().charCodeAt(0) : KEYS[k], modifiers };
        await send('Input.dispatchKeyEvent', { type: single && !mods.ctrl ? 'keyDown' : 'rawKeyDown', ...base, ...(single && !mods.ctrl ? { text: k } : {}), ...(k === 'Enter' && !mods.ctrl ? { text: '\r' } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      };
      const type = (text) => send('Input.insertText', { text });
      const until = async (expr, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { if (await ev(expr)) return Date.now() - t0; await sleep(25); }
        return -1;
      };
      await send('Page.bringToFront'); // a native drag starts only in the foreground tab, and earlier steps open others
      await until('document.readyState === "complete" && !!document.querySelector(".col, #problem:not([hidden]), #sess > *")', 5000);
      // A real mouse click at the element's centre; false when there is no such element.
      const click = async (sel) => {
        const at = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
        if (!at) return false;
        const [x, y] = at;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        await sleep(100);
        return true;
      };
      return { send, ev, key, type, until, click, on: (h) => handlers.push(h) };
    } catch { await sleep(100); }
  }
  throw new Error('no chromium');
}

// --- the file, as an agent sees it -------------------------------------------
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function agent(f, edit) { // jq '...' f > t && mv t f
  const b = read(f);
  edit(b);
  fs.writeFileSync(f + '.t', JSON.stringify(b, null, 2));
  fs.renameSync(f + '.t', f);
}
const card = (b, title) => b.columns.flatMap((c) => c.cards).find((c) => c.title === title);
const byId = (b, id) => b.columns.flatMap((c) => c.cards).find((c) => c.id === id);
const comment = (text) => ({ author: 'claude', time: '2026-10-15T14:02:00+03:00', text });
const board = (todo) => ({ instructions: 'test', columns: [
  { title: 'Todo', cards: todo.map((t) => ({ id: `id-${t}`, title: t, notes: `notes of ${t}` })) }, { title: 'Doing', cards: [] }, { title: 'Done', cards: [] }] });
// past the 300ms save debounce, then until the save has landed
const saved = async (p) => { await sleep(400); return p.until('document.querySelector("#status").dataset.state === "saved" && document.querySelector("#status").textContent === "saved"', 4000); };

async function fresh(port, todo, open = false) {
  const f = path.join(dir, `b${port}.json`);
  fs.writeFileSync(f, JSON.stringify(board(todo), null, 2));
  const url = await server(f, port, open);
  const k = procs.at(-1);
  const p = await tab(url);
  await p.until(`document.querySelectorAll('.card').length === ${todo.length}`);
  return { f, p, k };
}
// Wraps EventSource from the next load on, before the page's script runs, so
// its first stream is counted too. Returns how many of its streams are live.
async function streams(p) {
  await p.send('Page.enable'); // without it the script below never runs
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__es = []; window.EventSource = class extends EventSource { constructor(u) { super(u); __es.push(this); } };' });
  return () => p.ev(`__es.filter((e) => e.readyState !== EventSource.CLOSED).length`);
}
const run = (name) => !only || only === name;
const pages = async () => (await (await fetch('http://127.0.0.1:9339/json/list')).json()).filter((t) => t.type === 'page').length;
const shown = (sel) => `!!document.querySelector(${JSON.stringify(sel)})?.checkVisibility({ opacityProperty: true })`;
const notesView = '#card label[for=card-notes]';

// --- open, step, close ---------------------------------------------------
if (run('d1')) {
  const { f, p } = await fresh(4301, ['A', 'B', 'C']);
  agent(f, (b) => card(b, 'A').comments = [comment('first')]);
  await p.until(`document.querySelector('.card .meta')`);
  await p.ev(`document.querySelectorAll('.card')[0].click()`);
  check('click opens the modal with title, notes, column, comments',
    await p.ev(`document.querySelector('#card').open && document.querySelector('#card-title').value === 'A'
      && document.querySelector('#card label[for=card-notes]')?.textContent.trim() === 'notes of A'
      && document.querySelector('#card-cols [aria-pressed=true]').textContent === 'Todo'
      && document.querySelector('.comment-text').textContent.trim() === 'first'`));
  agent(f, (b) => (card(b, 'B').notes = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: agent wrote this`).join('\n')));
  await p.until(`document.querySelectorAll('.card .b')[1].textContent.includes('line 12')`);
  await p.key('Escape');
  await p.ev(`document.querySelectorAll('.card')[1].click()`);
  check('the rendered notes show all of a long note, without their own scroll',
    await p.until(`(() => { const v = document.querySelector('${notesView}'); return !!v && ${shown(notesView)} && v.textContent.includes('line 12') && v.scrollHeight <= v.clientHeight + 1; })()`, 1000) >= 0); // past the dialog's fade-in
  await p.click(notesView);
  check('the notes field, once clicked, shows all of a long note, without its own scroll',
    await p.ev(`(() => { const n = document.activeElement; return n.id === 'card-notes' && n.value.includes('line 12') && n.scrollHeight <= n.clientHeight + 1; })()`),
    await p.ev(`document.activeElement.id + ' ' + document.querySelector('#card-notes').scrollHeight + '/' + document.querySelector('#card-notes').clientHeight`));
  await p.key('Escape');
  await p.key('Escape');
  await p.ev(`document.querySelectorAll('.card')[0].click()`);
  check('opening focuses the dialog itself', await p.ev(`document.activeElement === document.querySelector('#card')`));
  await p.key('ArrowDown', { ctrl: true });
  check('Ctrl+↓ steps to the next card', await p.ev(`document.querySelector('#card-title').value === 'B'`));
  await p.key('ArrowUp', { ctrl: true });
  check('Ctrl+↑ steps back', await p.ev(`document.querySelector('#card-title').value === 'A'`), await p.ev(`document.querySelector('#card-title').value + ' focus=' + (document.activeElement.id || document.activeElement.tagName) + ' where=' + document.querySelector('#card-where').textContent`));
  await p.key('ArrowDown', { ctrl: true });
  await p.key('Escape');
  check('Esc closes', await p.until(`!document.querySelector('#card').open`, 1000) >= 0);
  check('closing leaves the board selection on the last card shown', await p.ev(`document.querySelectorAll('.card')[1].classList.contains('sel')`));
  await p.key('Enter');
  check('Enter on the selected card opens it', await p.until(`document.querySelector('#card').open && document.querySelector('#card-title').value === 'B'`, 1000) >= 0);
  // Esc in a field leaves the field, a second Esc closes
  await p.ev(`document.querySelector('#card-notes').focus()`);
  await p.key('Escape');
  check('Esc in a field returns to the dialog without closing', await p.ev(`document.querySelector('#card').open && document.activeElement === document.querySelector('#card')`));
  await p.key('Escape');
}

// --- an agent comment arrives while typing ---------------------------------
if (run('d3')) {
  const { f, p } = await fresh(4302, ['A', 'B']);
  await p.ev(`document.querySelectorAll('.card')[1].click()`);
  await p.ev(`document.querySelector('#card-draft').focus()`);
  await p.type('hello world');
  await p.ev(`(() => { const d = document.querySelector('#card-draft'); d.setSelectionRange(3, 5); window.__f = d; })()`);
  agent(f, (b) => (card(b, 'B').comments = [comment('agent says hi')]));
  const ms = await p.until(`[...document.querySelectorAll('.comment-text')].some((e) => e.textContent.trim() === 'agent says hi')`, 3000);
  check(`agent comment renders in the open modal within 1s (draft focused): ${ms}ms`, ms >= 0 && ms <= 1000);
  check('draft keeps its element, focus, text and selection',
    await p.ev(`(() => { const d = document.activeElement; return d === window.__f && d.isConnected && d.value === 'hello world' && d.selectionStart === 3 && d.selectionEnd === 5; })()`));

  await p.ev(`document.querySelector('#card-notes').focus(); document.querySelector('#card-notes').setSelectionRange(9, 9)`);
  await p.type('XYZ');
  await p.ev(`(() => { const n = document.querySelector('#card-notes'); n.setSelectionRange(2, 4); window.__f = n; })()`);
  await sleep(50);
  const t0 = Date.now();
  agent(f, (b) => card(b, 'B').comments.push(comment('second')));
  await sleep(400); // the pause after the last keystroke
  const ms2 = await p.until(`[...document.querySelectorAll('.comment-text')].some((e) => e.textContent.trim() === 'second')`, 3000);
  check(`agent comment renders while notes are being edited: ${Date.now() - t0}ms after the write (last keystroke ~450ms before)`, ms2 >= 0 && Date.now() - t0 <= 1450);
  check('notes keep their element, focus, text and selection',
    await p.ev(`(() => { const n = document.activeElement; return n === window.__f && n.isConnected && n.value === 'notes of XYZB' && n.selectionStart === 2 && n.selectionEnd === 4; })()`));
  await saved(p);
  check('typed notes reached the file with the agent comments', card(read(f), 'B').notes === 'notes of XYZB' && card(read(f), 'B').comments.length === 2);
}

// --- the modal follows its card; a comment lands on the right card -------------
if (run('follow')) {
  const { f, p } = await fresh(4303, ['A', 'B']);
  await p.ev(`document.querySelectorAll('.card')[1].click()`);
  agent(f, (b) => b.columns[0].cards.unshift({ id: 'id-Z', title: 'Z' }));
  await p.until(`document.querySelectorAll('.card').length === 3`);
  check('the modal still shows its card after one is inserted above', await p.ev(`document.querySelector('#card-title').value === 'B' && document.querySelector('#card-where').textContent.includes('3 of 3')`));
  await p.ev(`document.querySelector('#card-draft').focus()`);
  await p.type('on B');
  await p.key('Enter', { ctrl: true });
  await saved(p);
  check('a comment posted from the modal lands on the open card', JSON.stringify(byId(read(f), 'id-B').comments?.map((c) => c.text)) === '["on B"]' && !byId(read(f), 'id-Z').comments && !byId(read(f), 'id-A').comments);
  check('the posted comment carries the server user and an offset time', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(byId(read(f), 'id-B').comments[0].time) && byId(read(f), 'id-B').comments[0].author === os.userInfo().username);
  await p.ev(`document.querySelector('#card-draft').focus()`);
  await p.type('half-written');
  await p.ev(`document.querySelector('#card-title').focus(); document.querySelector('#card-title').select()`);
  await p.type('B renamed');
  await p.key('Enter');
  await p.key('ArrowUp', { ctrl: true });
  await p.key('ArrowDown', { ctrl: true });
  check('a draft follows its card through a rename', await p.ev(`document.querySelector('#card-title').value === 'B renamed' && document.querySelector('#card-draft').value === 'half-written'`),
    await p.ev(`document.querySelector('#card-title').value + ' / ' + document.querySelector('#card-draft').value`));
  await saved(p);
  agent(f, (b) => (byId(b, 'id-B').title = 'B by agent'));
  check('the modal and its unsent draft stay on their card through an agent\'s rename',
    await p.until(`document.querySelector('#card').open && document.querySelector('#card-title').value === 'B by agent' && document.querySelector('#card-draft').value === 'half-written'`) >= 0,
    await p.ev(`document.querySelector('#card').open + ' ' + document.querySelector('#card-title')?.value + ' / ' + document.querySelector('#card-draft')?.value`));
}

// --- every card the browser adds gets its own id from kban ---------------------
if (run('ids')) {
  const { f, p } = await fresh(4312, ['A']);
  const all = () => read(f).columns.flatMap((c) => c.cards);
  await p.ev(`document.activeElement.blur()`);
  await p.key('ArrowDown'); // select A
  for (let k = 0; k < 20; k++) { await p.key('n'); await p.type(`new ${k}`); await p.key('Enter', { ctrl: true }); }
  await saved(p);
  const ids = all().map((c) => c.id);
  check('20 cards added in a row land in the file, each with its own id',
    ids.length === 21 && new Set(ids).size === 21 && ids.every(Boolean) && all()[20]?.title === 'new 19', JSON.stringify(all().map((c) => [c.id, c.title])));
  await p.ev(`document.querySelectorAll('.card')[6].click()`); // new 5
  await p.ev(`document.querySelector('#card-title').focus(); document.querySelector('#card-title').select()`);
  await p.type('edited');
  await p.key('Enter');
  await p.key('Escape');
  await p.until(`!document.querySelector('#card').open`, 1000);
  await p.key('ArrowRight', { shift: true }); // to Doing
  await saved(p);
  const moved = read(f).columns[1].cards;
  check('an edited and moved card is still one card with its id', moved.length === 1 && moved[0].id === ids[6] && moved[0].title === 'edited' && all().length === 21,
    JSON.stringify(read(f).columns.map((c) => c.cards.map((x) => x.title))));
  await p.key('u');
  await saved(p);
  await p.key('u');
  await saved(p);
  await sleep(200);
  check('undoing both puts back every card, once each, in its place', JSON.stringify(all().map((c) => c.id)) === JSON.stringify(ids) && all()[6]?.title === 'new 5',
    JSON.stringify(all().map((c) => [c.id, c.title])));
}

// --- a new card reaches the file whole, title and notes together ----------------
if (run('add')) {
  const { f, p } = await fresh(4313, ['A']);
  const titles = () => read(f).columns.flatMap((c) => c.cards.map((x) => x.title));
  await p.click('.col[data-c="1"] .add-card'); // Doing
  check('Add card opens the modal with its title field focused',
    await p.until(`document.querySelector('#card').open && document.activeElement?.id === 'card-title'`, 1000) >= 0);
  await p.type('Spec first');
  await p.key('Enter');
  await p.type('the details');
  await sleep(800);
  check('nothing reaches the file while the new card is drafted, Enter on its title included', JSON.stringify(titles()) === '["A"]', JSON.stringify(titles()));
  await p.key('Escape');
  await p.key('Escape');
  await p.until(`!document.querySelector('#card').open`, 1000);
  await sleep(500);
  check('closing the modal writes nothing', JSON.stringify(titles()) === '["A"]', JSON.stringify(titles()));
  await p.click('.col[data-c="1"] .add-card');
  check('the closed draft comes back on the next Add card',
    await p.until(`document.querySelector('#card-title')?.value === 'Spec first' && document.querySelector('#card-notes')?.value === 'the details'`, 1000) >= 0);
  agent(f, (b) => b.columns.unshift({ title: 'Backlog', cards: [] }));
  await p.until(`document.querySelectorAll('.col').length === 4`);
  await p.key('Enter', { ctrl: true });
  await saved(p);
  const doing = read(f).columns.find((c) => c.title === 'Doing').cards;
  check('Ctrl+Enter writes the card with its notes, to the column it was opened in after an agent added one before it',
    doing.length === 1 && doing[0].title === 'Spec first' && doing[0].notes === 'the details' && !!doing[0].id && doing[0].id !== 'id-A'
      && await p.ev(`!document.querySelector('#card').open`), JSON.stringify(read(f).columns));
}

// --- u reverts only my last action --------------------------------------
if (run('undo-a') || run('undo')) {
  const { f, p } = await fresh(4304, ['A', 'B']);
  await p.ev(`document.querySelector('#board').focus?.(); document.activeElement.blur()`);
  await p.key('ArrowDown'); // select A
  await p.key('ArrowRight', { shift: true }); // move A to Doing
  await saved(p);
  check('(a) setup: the move reached the file', read(f).columns[1].cards[0]?.title === 'A');
  agent(f, (b) => { b.columns[0].cards.push({ id: 'id-agent', title: 'agent card' }); card(b, 'B').comments = [comment('agent note')]; });
  await p.until(`[...document.querySelectorAll('.card .t')].some((e) => e.textContent.trim() === 'agent card') && !!document.querySelector('.card .meta')`);
  await p.key('u');
  await saved(p);
  await sleep(200);
  const b = read(f);
  check('(a) undo of a move keeps the agent card and comment and puts the card back',
    b.columns[0].cards.map((c) => c.title).join() === 'A,B,agent card' && card(b, 'B').comments?.length === 1 && b.columns[1].cards.length === 0,
    JSON.stringify(b.columns.map((c) => c.cards.map((x) => x.title + (x.comments ? '*' : '')))));
}
if (run('undo')) {
  const { f, p } = await fresh(4305, ['X', 'Y']);
  // (b) notes edit, agent comment, u
  await p.ev(`document.querySelectorAll('.card')[0].click()`);
  await p.ev(`document.querySelector('#card-notes').focus()`);
  await p.type(' zz');
  await saved(p);
  agent(f, (b) => (card(b, 'X').comments = [comment('agent on X')]));
  await p.until(`[...document.querySelectorAll('.comment-text')].some((e) => e.textContent.trim() === 'agent on X')`);
  await p.key('Escape'); // leave the field
  await p.key('u');
  await saved(p);
  await sleep(200);
  let x = card(read(f), 'X');
  check('(b) undo of a notes edit reverts the notes and keeps the agent comment', x.notes === 'notes of X' && x.comments?.length === 1, JSON.stringify(x));
  // (c) rename, agent comment on the new title, u
  await p.key('ArrowDown', { ctrl: true }); // Y
  await p.ev(`document.querySelector('#card-title').focus(); document.querySelector('#card-title').select()`);
  await p.type('Y2');
  await p.key('Enter');
  await saved(p);
  check('(c) setup: the rename reached the file', byId(read(f), 'id-Y').title === 'Y2');
  agent(f, (b) => (card(b, 'Y2').comments = [comment('agent on Y2')]));
  await p.until(`[...document.querySelectorAll('.comment-text')].some((e) => e.textContent.trim() === 'agent on Y2')`);
  await p.key('u');
  await saved(p);
  await sleep(200);
  const y = byId(read(f), 'id-Y');
  check('(c) undo of a rename restores the title and keeps the comment', y.title === 'Y' && y.comments?.length === 1 && read(f).columns[0].cards.length === 2, JSON.stringify(read(f).columns[0]));
  check('(c) the modal is still on that card', await p.ev(`document.querySelector('#card').open && document.querySelector('#card-title').value === 'Y'`));
}

// --- a broken file at start: nothing editable, nothing sent ------------------
if (run('broken')) {
  const f = path.join(dir, 'broken.json');
  fs.writeFileSync(f, '{\n  "columns": [\n    {"title": "Todo", "cards": [], "colour": "red"}\n  ]\n}\n');
  const url = await server(f, 4306);
  const p = await tab(url);
  await p.until(`!document.querySelector('#problem').hidden`);
  check('the board shows the error with its line', await p.ev(`document.querySelector('#problem').textContent.includes('line 3') && document.querySelector('#problem').textContent.includes('colour')`));
  const beside = path.join(dir, 'beside-broken.json');
  fs.writeFileSync(beside, JSON.stringify(board(['x']), null, 2));
  const b = join(beside, 4306);
  await p.until(`!!document.querySelector('${entry(b.id)}')`);
  kban('add', '-f', beside, 'Todo', 'y');
  check('the banner stays after another board changes',
    b.ok && await p.until(dot(b.id)) >= 0 && await p.ev(`!document.querySelector('#problem').hidden && document.querySelector('#problem').textContent.includes('line 3')`));
  await p.ev(`window.__puts = 0; window.__log = []; const f0 = window.fetch; window.fetch = (u, o) => { if (o?.method === 'PUT') { window.__puts++; window.__log.push([Date.now(), o.body.slice(0, 400)]); } return f0(u, o); }`);
  await p.key('+');
  await p.type('New column');
  await p.key('Enter');
  await p.ev(`document.querySelector('#note').focus()`);
  await p.type('typed into instructions');
  const fixed = JSON.stringify(board(['kept']), null, 2);
  fs.writeFileSync(f, fixed);
  await p.until(`document.querySelectorAll('.card').length === 1`);
  await sleep(2500);
  check('nothing was sent before the first board, and the fixed file is unchanged',
    (await p.ev('window.__puts')) === 0 && fs.readFileSync(f, 'utf8') === fixed, `puts=${await p.ev('window.__puts')} same=${fs.readFileSync(f, 'utf8') === fixed} ${JSON.stringify(await p.ev('window.__log'))}`);
  check('the banner clears once the file reads', await p.ev(`document.querySelector('#problem').hidden`));
}

// --- a stream the browser gave up on is reopened -----------------------------
// Firefox gives up on a silent stream it drops after a network change.
// Chromium gives up when a reconnect is answered with an error, as here.
if (run('reopen')) {
  const { f, p, k } = await fresh(4314, ['A']);
  const live = await streams(p);
  await p.send('Page.reload');
  await p.until(`window.__es?.length === 1 && document.querySelectorAll('.card').length === 1`);
  k.kill('SIGKILL');
  await new Promise((r) => k.once('exit', r));
  let asked = 0;
  const standIn = http.createServer((req, res) => { if (req.url.endsWith('/events')) asked++; res.writeHead(503, { Connection: 'close' }).end(); });
  await new Promise((r) => standIn.listen(4314, '127.0.0.1', r));
  for (let i = 0; i < 100 && !asked; i++) await sleep(100);
  await sleep(500);
  await new Promise((r) => standIn.close(r));
  await server(f, 4314);
  agent(f, (b) => b.columns[0].cards.push({ id: 'id-B', title: 'B' }));
  const arrived = asked > 0 && await p.until(`document.querySelectorAll('.card').length === 2`, 8000) >= 0;
  await sleep(2500); // past the page's 2s reopen, so a stream it left open has opened too
  const n = await live();
  check('after the browser gave up on the stream, an agent\'s card still reaches the page, over one stream',
    arrived && n === 1, `stand-in asked ${asked} times, ${n} live streams`);
}

// --- a board that failed to load is loaded again ------------------------------
if (run('loadfail')) {
  const { p } = await fresh(4315, ['A']);
  let asked = 0;
  p.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId } = m.params;
    if (asked++) p.send('Fetch.continueRequest', { requestId });
    else p.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
  });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/board' }] });
  await p.send('Page.reload');
  check('a board whose first load failed still shows',
    await p.until(`document.querySelectorAll('.card').length === 1`, 5000) >= 0 && asked > 1, `${asked} board requests`);
}

// --- the stream is lost while the board loads: one stream comes back ----------
if (run('loadlost')) {
  const { f, p, k } = await fresh(4316, ['A']);
  const live = await streams(p);
  let held = null;
  p.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    if (held === null) held = m.params.requestId;
    else p.send('Fetch.continueRequest', { requestId: m.params.requestId });
  });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/board' }] });
  await p.send('Page.reload');
  for (let i = 0; i < 50 && held === null; i++) await sleep(100);
  k.kill('SIGKILL');
  await new Promise((r) => k.once('exit', r));
  const lostFirst = await p.until(`__es[0].readyState === EventSource.CLOSED`) >= 0; // the stream's error before the load's
  await p.send('Fetch.failRequest', { requestId: held, errorReason: 'ConnectionRefused' });
  await server(f, 4316);
  const shown = await p.until(`document.querySelectorAll('.card').length === 1`, 5000) >= 0;
  await sleep(2500); // past the page's 2s reopen, so a second one has opened too
  const n = await live();
  check('a stream lost while its board loaded comes back once', held !== null && lostFirst && shown && n === 1, `${n} live streams`);
}

// --- the stream reopens while a save keeps failing: never "saved" ------------
if (run('unsaved')) {
  const { f, p, k } = await fresh(4317, ['A', 'B']);
  await streams(p);
  await p.send('Page.reload');
  await p.until(`window.__es?.length === 1 && document.querySelectorAll('.card').length === 2`);
  p.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (request.method === 'PUT') p.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
    else p.send('Fetch.continueRequest', { requestId });
  });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/board' }] });
  // Every status shown, so a "saved" between two failed saves is caught.
  await p.ev(`window.__said = []; new MutationObserver(() => __said.push(document.querySelector('#status').textContent)).observe(document.querySelector('#status'), { childList: true, characterData: true, subtree: true }); 0`);
  await p.ev(`document.querySelectorAll('.card .x')[0].click()`);
  await p.until(`document.querySelector('#status').dataset.state === 'error'`);
  k.kill('SIGKILL');
  await new Promise((r) => k.once('exit', r));
  await server(f, 4317);
  const reopened = await p.until(`__es.length > 1 && __es.at(-1).readyState === EventSource.OPEN`, 6000) >= 0;
  await sleep(500);
  const said = await p.ev(`__said`);
  check('a save that has not landed is never shown as saved',
    reopened && !said.includes('saved') && !!card(read(f), 'A'), JSON.stringify(said));
}

// --- one hub serves every board; the sidebar marks the changed ones ----------
if (run('hub')) {
  const { f, p } = await fresh(4318, ['A1']);
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, JSON.stringify(board(['B1']), null, 2));
  const b = join(other, 4318);
  const idA = (await p.ev('location.pathname')).split('/')[2];
  check('a second kban on the port joins the hub, and both boards are listed, unmarked',
    b.ok && b.url.endsWith(`/b/${b.id}`) && await p.until(`!!document.querySelector('${entry(idA)}') && !!document.querySelector('${entry(b.id)}')`) >= 0
      && !await p.ev(`${dot(idA)} || ${dot(b.id)}`), JSON.stringify(b));
  const added = kban('add', '-f', f, 'Todo', 'agent on A') && kban('add', '-f', other, 'Todo', 'agent on B');
  const marked = added && await p.until(`${dot(b.id)} && [...document.querySelectorAll('.card .t')].some((e) => e.textContent === 'agent on A')`) >= 0;
  check('an agent changes both: the other board gets a dot, the shown one shows the change and no dot',
    marked && !await p.ev(dot(idA)), `marked=${marked} dotA=${await p.ev(dot(idA))}`);
  // The rename's save is held, so a tab that left without waiting for it is gone by then.
  let held = null;
  p.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    if (m.params.request.method === 'PUT' && held === null) held = m.params.requestId;
    else p.send('Fetch.continueRequest', { requestId: m.params.requestId });
  });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/board' }] });
  await p.click('.col[data-c="0"] .col-head .t');
  await p.type('Renamed');
  await p.click(entry(b.id)); // within 100ms of the last keystroke
  for (let i = 0; i < 50 && held === null; i++) await sleep(20);
  await sleep(500);
  const waited = held !== null && await p.ev('location.pathname') === `/b/${idA}`;
  if (held !== null) await p.send('Fetch.continueRequest', { requestId: held });
  const moved = await p.until(`location.pathname === '/b/${b.id}' && [...document.querySelectorAll('.card .t')].some((e) => e.textContent === 'B1')`, 5000) >= 0;
  await p.send('Fetch.disable');
  check('a column rename followed at once by a sidebar click stays until its save lands, then the file has it and the tab shows the board clicked',
    waited && moved && read(f).columns[0].title === 'Renamed', `held=${held !== null} waited=${waited} moved=${moved} ${JSON.stringify(read(f).columns.map((c) => c.title))}`);
  await p.until(`!!document.querySelector('${entry(idA)}')`);
  await sleep(1100); // past two polls, so the list names A's version after the rename
  check('the board left right after its own save has no dot', !await p.ev(dot(idA)));
  check('the board clicked has lost its dot, and the header names its project and file',
    await p.until(`!!document.querySelector('${entry(b.id)}') && !${dot(b.id)}`) >= 0 && await p.ev(`document.querySelector('#file').textContent`) === `${path.basename(dir)} / other.json`,
    await p.ev(`document.querySelector('#file').textContent + ' dot=' + ${dot(b.id)}`));
}

// --- Markdown in notes and comments, driven by mouse and keys ------------------
if (run('md')) {
  const { f, p } = await fresh(4308, ['A', 'B']);
  const src = 'see [docs](https://example.com/docs) and **bold**\nsecond line';
  agent(f, (b) => { card(b, 'A').notes = src; card(b, 'A').comments = [comment('first')]; });
  await p.until(`!!document.querySelector('.card .meta')`);
  let n0 = await pages();
  const linked = await p.click('.card .b a');
  check('a click on a link on the card face opens the card, not the link',
    linked && await p.until(`document.querySelector('#card').open && document.querySelector('#card-title').value === 'A'`, 1000) >= 0 && await pages() === n0,
    `link=${linked} pages ${n0}->${await pages()}`);
  check('links on the card face are out of the tab order, as the card itself is',
    await p.ev(`(() => { const a = [...document.querySelectorAll('.card .b a')]; return a.length > 0 && a.every((e) => e.tabIndex < 0); })()`));
  if (!await p.ev(`document.querySelector('#card').open`)) await p.ev(`document.querySelectorAll('.card')[0].click()`);

  await p.click('#card-title');
  await p.key('Tab');
  check('Tab from the title edits the notes source in a visible field',
    await p.ev(`document.activeElement.id === 'card-notes' && ${shown('#card-notes')} && document.activeElement.value === ${JSON.stringify(src)}`),
    await p.ev(`document.activeElement.id + ' visible=' + ${shown('#card-notes')}`));
  const stops = [];
  for (let k = 0; k < 3; k++) {
    await p.key('Tab');
    stops.push(await p.ev(`(document.activeElement.id || document.activeElement.className || document.activeElement.tagName) + ':' + document.activeElement.checkVisibility({ opacityProperty: true })`));
  }
  check('every Tab stop after the notes is visible', stops.every((s) => s.endsWith(':true')), stops.join(' '));
  await p.click(notesView);
  await p.key('End', { ctrl: true });
  await p.type(' **new**');
  await p.key('Escape');
  check('leaving the notes shows them rendered at once, with the edit',
    await p.ev(`${shown(notesView)} && [...document.querySelectorAll('${notesView} strong')].some((e) => e.textContent === 'new')`),
    await p.ev(`document.querySelector('${notesView}')?.innerHTML`));
  await p.click(`${notesView} strong`);
  check('a click on the rendered notes edits their source',
    await p.ev(`document.activeElement.id === 'card-notes' && ${shown('#card-notes')} && !${shown(notesView)}`));
  await p.key('Escape');

  n0 = await pages();
  await p.click(`${notesView} a`);
  check('a click on a link in the notes opens it and does not edit',
    await pages() === n0 + 1 && await p.ev(`document.activeElement.id !== 'card-notes'`),
    `pages ${n0}->${await pages()} focus=${await p.ev('document.activeElement.id')}`);
}

// --- fields beside the rendered notes ---------------------------------------
if (run('fields')) {
  const { f, p } = await fresh(4309, ['A', 'B']);
  // The source and the rendered notes differ in height, so leaving the
  // field moves what is below it.
  agent(f, (b) => { card(b, 'A').notes = '## Plan\n\none\n\n- two\n- three\n\n```\nfour\n```'; card(b, 'A').comments = [comment('first')]; });
  await p.until(`!!document.querySelector('.card .meta')`);
  await p.click('.card .t');
  await p.until(`document.querySelector('#card').open`, 1000);
  await p.click('#card-title');
  await p.key('Tab');
  await p.click('.comment .x');
  check('the comment delete button below the notes deletes while the notes are being edited',
    await p.until(`!document.querySelector('.comment-text')`, 1000) >= 0);

  await p.click('#card-title');
  await p.key('End');
  await p.type(' typed');
  const before = await p.ev(`(() => { const t = document.querySelector('#card-title'); return [t.value, t.selectionStart, t.selectionEnd].join(); })()`);
  agent(f, (b) => card(b, 'A').comments = [comment('while typing')]);
  const seen = await p.until(`[...document.querySelectorAll('.comment-text')].some((e) => e.textContent.trim() === 'while typing')`);
  check('an agent comment while typing the title leaves its text and caret',
    seen >= 0 && await p.ev(`(() => { const t = document.activeElement; return t.id === 'card-title' && [t.value, t.selectionStart, t.selectionEnd].join(); })()`) === before && before === 'A typed,7,7',
    `seen=${seen} before=${before} after=${await p.ev(`[document.activeElement.id, document.activeElement.value, document.activeElement.selectionStart].join()`)}`);
  await p.key('Escape');
  await p.key('c');
  await p.type('posted');
  await p.key('Enter', { ctrl: true });
  check('the comment field is empty after Ctrl+Enter posts',
    await p.until(`[...document.querySelectorAll('.comment-text')].some((e) => e.textContent.trim() === 'posted')`, 1000) >= 0 && await p.ev(`document.querySelector('#card-draft').value === ''`));
}

// --- Markdown and HTML an agent writes ----------------------------------------
if (run('agent-md')) {
  const { f, p } = await fresh(4310, ['A', 'B', 'C']);
  await p.click('.card .t');
  await p.until(`document.querySelector('#card').open`, 1000);
  await p.key('ArrowDown', { ctrl: true });
  const evil = '**b** <img src=x onerror="window.__x=1">';
  agent(f, (b) => { card(b, 'B').notes = evil; card(b, 'B').comments = [comment(evil)]; });
  await p.until(`!!document.querySelector('.comment-text strong')`);
  check('Markdown renders in a comment, on the card face and in the modal notes',
    await p.ev(`!!document.querySelector('.comment-text strong') && [...document.querySelectorAll('.card .b strong')].some((e) => e.textContent === 'b') && !!document.querySelector('${notesView} strong') && document.querySelector('#card-title').value.startsWith('B')`));
  check('HTML in the file shows as text and never runs',
    await p.ev(`!document.querySelector('#board img, #card img') && window.__x === undefined && document.querySelector('.comment-text').textContent.includes('<img src=x onerror="window.__x=1">')`));
  agent(f, (b) => {
    card(b, 'A').notes = '```\n' + Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') + '\n```';
    card(b, 'C').notes = '| a |\n|---|\n' + Array.from({ length: 12 }, (_, i) => `| ${i} |`).join('\n');
  });
  await p.until(`!!document.querySelector('.card .b pre') && !!document.querySelector('.card .b table')`);
  const heights = await p.ev(`[...document.querySelectorAll('.card .b')].map((b) => b.clientHeight + '/' + 3 * parseFloat(getComputedStyle(b).lineHeight))`);
  check('a code block or a table on the card face stays within three lines', heights.every((h) => +h.split('/')[0] <= +h.split('/')[1] + 1), heights.join(' '));
}

// --- drag and drop, with real mouse input --------------------------------------
if (run('drag')) {
  const f = path.join(dir, 'drag.json');
  fs.writeFileSync(f, JSON.stringify({ columns: Array.from({ length: 9 }, (_, c) => ({ title: `C${c}`, cards: [{ id: `x${c}`, title: `x${c}`, notes: '**x**' }, { id: `y${c}`, title: `y${c}` }] })) }, null, 2));
  const p = await tab(await server(f, 4311));
  await p.until(`document.querySelectorAll('.card').length === 18`);
  await p.key('ArrowDown'); // selects x0, at the far left
  await p.ev(`document.querySelector('main').scrollLeft = 99999`);
  const at = (sel) => p.ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const [x0, y0] = await at('.col[data-c="8"] .card[data-i="0"]');
  const scroll0 = await p.ev(`document.querySelector('main').scrollLeft`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  for (let s = 1; s <= 6; s++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 + s * 6, button: 'left', buttons: 1 }); await sleep(30); }
  const scroll1 = await p.ev(`document.querySelector('main').scrollLeft`);
  check('starting a drag leaves the board where it was scrolled', scroll0 > 0 && scroll1 === scroll0, `${scroll0} -> ${scroll1}`);
  const [x1, y1] = await at('.col[data-c="7"] .add-card');
  for (let s = 1; s <= 20; s++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * s / 20, y: y0 + (y1 - y0) * s / 20, button: 'left', buttons: 1 }); await sleep(20); }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  await saved(p);
  const cols = read(f).columns.map((c) => c.cards.map((x) => x.title).join());
  check('a card dragged to another column lands at its end, in the file and back at full opacity',
    cols[7] === 'x7,y7,x8' && cols[8] === 'y8' && await p.ev(`!document.querySelector('.dragging, .drop')`), JSON.stringify(cols.slice(7)));
  await p.key('Enter');
  await p.until(`document.querySelector('#card').open && document.querySelector('#card-title').value === 'x8'`, 1000);
  for (let k = 0; k < 8 && !(await p.ev(`document.activeElement.id === 'card-notes'`)); k++) await p.key('Tab');
  await p.key('Escape');
  check('after a drag, leaving the notes by keyboard shows them rendered',
    await p.until(`document.activeElement.id !== 'card-notes' && ${shown(notesView)} && !document.querySelector('.notes.held')`, 1000) >= 0, // past the dialog's fade-in
    await p.ev(`document.activeElement.id + ' held=' + !!document.querySelector('.notes.held')`));
}

// --- grill: an agent session's question, answered in the hub -------------------
function relay(port, session) {
  const p = spawn(bin, ['mcp', '-p', String(port)], { env: { ...env, CLAUDE_CODE_SESSION_ID: session }, cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
  procs.push(p);
  const got = new Map();
  let buf = '';
  let id = 0;
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { const m = JSON.parse(buf.slice(0, i)); if (m.id) got.set(m.id, m); }
  });
  const call = (method, params) => { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n'); return id; };
  call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'check', version: '0' } });
  return {
    ask: (q) => call('tools/call', { name: 'ask', arguments: q }),
    report: (text) => call('tools/call', { name: 'report', arguments: { text } }),
    cancel: (rid) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: rid } }) + '\n'),
    reply: async (rid, ms = 5000) => {
      for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
        const r = got.get(rid)?.result;
        if (r) return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
      }
      return null;
    },
    stop: () => new Promise((r) => { p.once('exit', r); p.stdin.end(); }),
  };
}
const small = (id, labels, hard = false) => ({ id, task: 'grill in the hub', question: `Which way for ${id}?`,
  ...(hard ? { hard_to_undo: true } : { hard_to_undo: false, say_ok: 'take the first' }), today: 'Today.', problem: 'Problem.',
  options: labels.map((label) => ({ label, get: 'g', cost: 'c', undo: 'u' })) });
const q1 = (id) => `document.querySelector('.q[data-q="${id}"]')`;
const allDrawn = `[...document.querySelectorAll('.blk[data-kind=diagram]')].every((d) => d.querySelector('svg'))`;
const CLIPS = `[...document.querySelectorAll('.panel, .panel *')].filter((e) => !e.closest('.scroll, svg') && e.clientWidth > 0 && e.clientHeight > 0
  && e.scrollWidth > e.clientWidth + 1).map((e) => (e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth)`;
// A settled page stays still: a class or style change after layout means two rules feed each other.
const STILL = `new Promise((res) => { const seen = []; const mo = new MutationObserver((ms) => ms.forEach((m) => seen.push((m.target.className?.baseVal ?? m.target.className) + ' ' + m.attributeName)));
  mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] }); setTimeout(() => { mo.disconnect(); res(seen); }, 3000); })`;
// Grain and glow are background images; motion is a transition.
const DECOR = `JSON.stringify({ coarse: matchMedia('(pointer: coarse)').matches, body: getComputedStyle(document.body).backgroundImage,
  panel: getComputedStyle(document.querySelector('.panel')).backgroundImage, opt: getComputedStyle(document.querySelector('.opt')).transitionDuration })`;
const decorated = (b) => b.includes('url(') && b.includes('radial-gradient');

if (run('grill')) {
  const png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQB6OsbwAAAAAElFTkSuQmCC', 'base64'));
  // Long unbroken tokens, which only overflow-wrap breaks at 390px.
  const every = { ...small('D1', ['Postgres', 'Redis', 'MemoryWithWriteBehindToTheSecondaryRegionOnEveryCommit']), task: 'session store', n: 2, total: 5,
    question: 'Which store **holds** sessions, `SessionStore.persistAcrossRestartsWithReplication()`?',
    evidence: ['web/src/components/question/composer/keyboard-shortcuts.jsx:141 binds the keys', 'ui/settings.js:41 opens a modal', 'a plain note'],
    context: [
      { kind: 'text', title: 'What changes', text: '- **Filters** apply live\n- `localStorage` goes' },
      { kind: 'code', title: 'ui/settings.js', lang: 'js', code: 'if (a < b && c) open();' },
      { kind: 'table', columns: ['Session', 'Opens'], rows: [['2026-10-04', '6'], ['2026-10-05', '-']] },
      { kind: 'diagram', title: 'Where an answer goes', mermaid: 'flowchart LR\n  U[your answer] --> S[server memory]\n  S --> M[model, as the tool result]\n  M --> L[ship ledger or commit body]' },
    ],
    rows: [{ label: 'Latency', cells: ['1 ms', '0.2 ms', '-'] },
      { label: 'Flow', cells: ['B', 'C', 'D'].map((x) => ({ kind: 'diagram', mermaid: `flowchart TB\n  A[answer] --> ${x}[model]` })) }],
    detail: [{ kind: 'diff', diff: '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--a\n+++b\n keep' }, { kind: 'image', title: 'Today', path: png },
      { kind: 'stats', items: [{ label: 'Opens', value: '5.4', note: 'median' }, { label: 'Closes', value: '2' }] }] };
  // This hub opens tabs, as the owner's does: its board's at start, and a question's that no tab acks.
  const { f, p: board, k } = await fresh(4320, ['A'], true);
  const port = 4320;
  const base = `http://127.0.0.1:${port}`;
  await fetch('http://127.0.0.1:9339/json/new?about:blank', { method: 'PUT' });
  await sleep(300);
  const r = relay(port, 'sess-1');
  let rid = r.ask(every);
  const badge = await board.until(`!!document.querySelector('#side a.item.ask[href="/s/sess-1"] .badge')`, 3000);
  const project = await board.ev(`[...document.querySelectorAll('#side .group')].find((g) => g.querySelector('a.item.ask'))?.querySelector('.head').textContent`);
  await sleep(4000);
  check('a question reaches a hidden board tab\'s sidebar under its project, with a badge, and no tab opens after 4s',
    await board.ev('document.visibilityState') === 'hidden' && badge >= 0 && project === path.basename(dir) && !tabsOpened().some((u) => u.includes('/s/')),
    `visibility=${await board.ev('document.visibilityState')} badge=${badge} project=${project} opened=${tabsOpened()} refused=${JSON.stringify(await r.reply(rid, 1))}`);

  const p = await tab(`${base}/s/sess-1`);
  await p.until(q1('D1'));
  await p.until(allDrawn, 20000);
  const missing = await p.ev(`(() => { const want = ${JSON.stringify([
    ['context[0]', 'Filters apply live'], ['context[1]', 'if (a < b && c) open();'], ['context[2]', '2026-10-05'], ['detail[2]', 'median'],
    ['rows[0].cells[2]', '-'], ['options[1].cost', 'c'], ['detail[0]', '+b'], ['detail[1]', ''],
  ])};
    const out = want.filter(([p, t]) => !document.querySelector('[data-path="' + p + '"]')?.textContent.includes(t)).map(([p]) => p);
    if (!document.querySelector('[data-path="detail[1]"] img')?.getAttribute('src').endsWith('/file/' + encodeURIComponent('detail[1]'))) out.push('detail[1] img');
    for (const p of ['context[3]', 'rows[1].cells[0]', 'rows[1].cells[2]']) if (!document.querySelector('[data-path="' + p + '"] svg')) out.push(p + ' svg');
    if (document.querySelector('[data-path="rows[0].cells[2]"] li, [data-path="context[2]"] td li')) out.push('a "-" became a list');
    if (!document.querySelector('[data-path="context[0]"] li strong')) out.push('context[0] markdown');
    return out; })()`);
  check('every block kind renders, Markdown in text, "-" in a cell as text', missing.length === 0, JSON.stringify(missing));
  check('the header names the task, project and the page is the session\'s',
    await p.ev(`document.querySelector('#file').textContent`) === `session store · ${path.basename(dir)}` && (await p.ev('document.title')).startsWith('● session store'),
    await p.ev(`document.querySelector('#file').textContent + ' | ' + document.title`));

  await sleep(1000);
  const moved = await p.ev(STILL);
  check('a page with diagrams stays still for 3s once settled', moved.length === 0, JSON.stringify(moved.slice(0, 8)));
  // The theme toggle draws the diagrams again in the new tokens: Mermaid writes colours, not var().
  const fill = `getComputedStyle(document.querySelector('[data-path="context[3]"] svg .node rect, [data-path="context[3]"] svg .node path')).fill`;
  const fill0 = await p.ev(fill);
  await p.click('#theme');
  const redrawn = await p.until(`${fill} !== ${JSON.stringify(fill0)}`, 3000);
  check('the theme toggle redraws a diagram in the new colours', redrawn >= 0, `fill stayed ${fill0}`);
  await p.click('#theme');
  await p.until(`${fill} === ${JSON.stringify(fill0)}`, 3000);
  const fine = JSON.parse(await p.ev(DECOR));
  check('a fine pointer keeps grain, glow and motion', !fine.coarse && decorated(fine.body) && decorated(fine.panel) && fine.opt !== '0s', JSON.stringify(fine));

  // Mermaid draws in the diagram's own box, never in one it mounts on body: body is a flex row,
  // and such a box squeezed the panel for frames in Firefox. Headless Chromium paints no frame
  // between mount and removal, so the box itself is what is watched.
  await p.send('Page.enable');
  const { identifier } = (await p.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__onBody = []; addEventListener('DOMContentLoaded', () =>
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.querySelector?.('svg') && __onBody.push(n.id || n.tagName)))).observe(document.body, { childList: true }));` })).result;
  await p.send('Page.reload');
  await p.until(q1('D1'), 5000);
  await p.until(allDrawn, 20000);
  const onBody = await p.ev('window.__onBody');
  check('no diagram is drawn in a box mounted on body', onBody.length === 0, JSON.stringify(onBody));
  await p.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await p.send('Page.reload');
  await p.until(q1('D1'), 5000);
  await p.until(allDrawn, 20000);
  await p.ev(`document.querySelectorAll('details').forEach((d) => d.open = true)`);
  await sleep(500);
  const clips = await p.ev(CLIPS);
  check('nothing clips at 390px', clips.length === 0, clips.slice(0, 8).join('; '));
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await p.send('Page.reload');
  await p.until(q1('D1'), 5000);
  const coarse = JSON.parse(await p.ev(DECOR));
  check('a coarse pointer has no grain, glow or motion', coarse.coarse && !decorated(coarse.body) && !decorated(coarse.panel) && coarse.opt === '0s', JSON.stringify(coarse));
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await p.send('Emulation.clearDeviceMetricsOverride');
  await p.send('Page.reload');
  await p.until(q1('D1'), 5000);

  await p.click('.opt[data-i="1"]');
  await p.click('.words');
  await p.type('a [b] "c" <d>');
  await p.key('Enter', { ctrl: true });
  let a = await r.reply(rid);
  check('the page sends B with the words verbatim', a?.kind === 'option' && a.option === 'B' && a.label === 'Redis' && a.words === 'a [b] "c" <d>', JSON.stringify(a));
  check('then it waits for the next question and lists the answer in the sitting',
    await p.until(`document.querySelector('#sess .msg h2')?.textContent === 'Sent.' && document.querySelector('.sit[data-id="D1"] .ans')?.textContent.includes('B · Redis')`) >= 0);

  const show = async (q) => { const id = r.ask(q); await p.until(`${q1(q.id)} && ${q1(q.id)}.querySelector('.opt')`, 5000); await sleep(100); return id; };
  const pressed = (id) => p.ev(`[...${q1(id)}.querySelectorAll('.opt')].findIndex((o) => o.getAttribute('aria-checked') === 'true')`);
  rid = await show(small('K1', ['North', 'South', 'East']));
  await p.ev(`${q1('K1')}.querySelector('[data-ask]').click()`);
  a = await r.reply(rid);
  check('Ask with nothing picked', a?.kind === 'ask' && a.option === null && a.words === '', JSON.stringify(a));
  rid = await show(small('K1', ['North', 'South', 'East']));
  await p.click('.opt[data-i="1"]');
  await p.click('.words');
  await p.type('why "B", not [A]');
  await p.ev(`${q1('K1')}.querySelector('[data-ask]').click()`);
  a = await r.reply(rid);
  check('Ask with B and words sends B as a lean', a?.kind === 'ask' && a.option === 'B' && a.label === 'South' && a.words === 'why "B", not [A]', JSON.stringify(a));
  rid = await show(small('K1', ['North', 'East', 'South']));
  const leaned = await pressed('K1');
  await p.ev(`${q1('K1')}.querySelector('.answer .primary').click()`);
  a = await r.reply(rid);
  check('the re-ask preselects the lean by its label', leaned === 2 && a?.kind === 'option' && a.option === 'C' && a.label === 'South', `${leaned} ${JSON.stringify(a)}`);
  rid = await show(small('K2', ['South', 'North'], true));
  await p.click('.opt[data-i="0"]');
  await p.ev(`${q1('K2')}.querySelector('[data-ask]').click()`);
  await r.reply(rid);
  rid = await show(small('K2', ['North', 'South'], true));
  const hardLean = [await pressed('K2'), await p.ev(`${q1('K2')}.querySelector('.echo').textContent`)];
  await p.click('.opt[data-i="1"]');
  await p.ev(`${q1('K2')}.querySelector('.answer .primary').click()`);
  check('a hard-to-undo re-ask names the lean but picks nothing, and Send without a why shows the server\'s message',
    hardLean[0] === -1 && hardLean[1].includes('South') && await p.until(`${q1('K2')}.querySelector('.status').textContent.includes('why')`) >= 0,
    JSON.stringify(hardLean) + ' ' + await p.ev(`${q1('K2')}.querySelector('.status').textContent`));

  await p.click('.words');
  await p.type('cancelled words');
  r.cancel(rid);
  check('a cancel in the terminal keeps the typed words',
    await p.until(`!document.querySelector('.q') && document.querySelector('.unsent')?.textContent.includes('Your unsent words for K2') && document.querySelector('.unsent pre').textContent === 'cancelled words'`) >= 0);
  rid = await show(small('Q6', ['North', 'South']));
  await p.click('.words');
  await p.type('restart words');
  k.kill('SIGKILL');
  await new Promise((done) => k.once('exit', done));
  await server(f, port);
  a = await r.reply(rid);
  check('a hub restart mid-question: the call gets the hub error, the page waits and keeps the words',
    a?.error?.startsWith('kban hub not reachable') && await p.until(`!document.querySelector('.q') && document.querySelector('#sess .msg') && [...document.querySelectorAll('.unsent pre')].some((e) => e.textContent === 'restart words')`, 6000) >= 0,
    JSON.stringify(a));
  await show(small('Q7', ['North', 'South']));
  await p.click('.words');
  await p.type('last words');
  await r.stop();
  check('a session that ended shows waiting, with the words kept',
    await p.until(`!document.querySelector('.q') && document.querySelector('#sess .msg') && [...document.querySelectorAll('.unsent pre')].some((e) => e.textContent === 'last words')`, 3000) >= 0
      && !await p.ev(`/ended|gone/i.test(document.querySelector('#sess').textContent)`));
  const never = await tab(`${base}/s/never-seen`);
  check('a session never seen shows as waiting', await never.until(`document.querySelector('#sess .msg h2')?.textContent === 'No question open.'`) >= 0);

  let hits = 0;
  const detector = http.createServer((req, res) => { hits++; res.end(); });
  await new Promise((done) => detector.listen(4399, '127.0.0.1', done));
  const X = '<img src=x onerror="window.__x=1"> [j](javascript:window.__x=1) <img src=http://127.0.0.1:4399/f>';
  const H = '<img src=x onerror="window.__x=1">';
  const blk = (b) => ({ title: X, ...b });
  const hostile = { id: 'H1', task: H, question: X, say_ok: X, hard_to_undo: false, today: X, problem: X, evidence: [X, `a.js:1 ${X}`],
    context: [blk({ kind: 'text', text: X }), blk({ kind: 'code', lang: X, code: X }), blk({ kind: 'table', columns: [X], rows: [[X]] }),
      blk({ kind: 'diagram', mermaid: '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A["<img src=http://127.0.0.1:4399/a onerror=window.__x=1>"] --> B' })],
    options: [{ label: X, get: X, cost: X, undo: X }, { label: H, get: H, cost: H, undo: H }],
    rows: [{ label: X, cells: [X, X] }, { label: 'Flow', cells: [
      blk({ kind: 'diagram', mermaid: 'flowchart LR\n  A --> B\n  click A "javascript:window.__x=1"' }),
      blk({ kind: 'diagram', mermaid: 'sequenceDiagram\n  A->>B: <img src=http://127.0.0.1:4399/c onerror="window.__x=1">' })] },
    { label: 'Theme', cells: [
      blk({ kind: 'diagram', mermaid: '%%{init: {"themeCSS": "* { cursor: url(http://127.0.0.1:4399/t), auto }", "fontFamily": "x; cursor: url(http://127.0.0.1:4399/f), auto"}}%%\nflowchart LR\n  A --> B' }),
      blk({ kind: 'diagram', mermaid: 'flowchart LR\n  C --> D' })] }],
    detail: [blk({ kind: 'diff', diff: X }), blk({ kind: 'stats', items: [{ label: X, value: X, note: X }] })] };
  const r2 = relay(port, 'hostile');
  rid = r2.ask(hostile);
  const hp = await tab(`${base}/s/hostile`);
  if (await hp.until(q1('H1'), 5000) < 0) throw new Error(`the hostile question was refused: ${JSON.stringify(await r2.reply(rid, 1))}`);
  await hp.until(allDrawn, 20000);
  await hp.ev(`document.querySelectorAll('details').forEach((d) => d.open = true)`);
  await hp.ev(`document.querySelectorAll('.blk[data-kind=diagram] svg g').forEach((g) => g.dispatchEvent(new MouseEvent('click', { bubbles: true })))`);
  await sleep(1500);
  const safe = JSON.parse(await hp.ev(`JSON.stringify({ x: window.__x, onerror: document.querySelectorAll('[onerror]').length, img: document.querySelectorAll('#sess img, #side img').length,
    js: document.querySelectorAll('a[href^="javascript" i]').length, text: document.querySelector('.q h1').textContent.includes('onerror') })`));
  check('a hostile question renders its HTML as text: nothing runs, loads or links to javascript:',
    safe.x === undefined && safe.onerror === 0 && safe.img === 0 && safe.js === 0 && safe.text && hits === 0, `${JSON.stringify(safe)} detector hits=${hits}`);
  r2.cancel(rid);
  detector.close();
}

// --- two relays of one session ask the same id --------------------------------
if (run('grill2')) {
  const port = 4321;
  await fresh(port, ['A']);
  const base = `http://127.0.0.1:${port}`;
  const ra = relay(port, 'twin');
  const rb = relay(port, 'twin');
  const q = small('K1', ['North', 'South', 'East']);
  let ida = ra.ask(q);
  const p = await tab(`${base}/s/twin`);
  await p.until(`!!document.querySelector('.q[data-q="K1"] .opt')`);
  await p.click('.opt[data-i="1"]');
  await p.ev(`document.querySelector('.q [data-ask]').click()`);
  await ra.reply(ida);
  await p.until(`!document.querySelector('.q')`);
  ida = ra.ask(q); // A re-asks K1 with its lean
  await p.until(`document.querySelectorAll('.q').length === 1`);
  const idb = rb.ask(q);
  await p.until(`document.querySelectorAll('.q').length === 2`);
  await p.ev(`window.__a = document.querySelectorAll('.q')[0]; window.__b = document.querySelectorAll('.q')[1]; window.__bw = __b.querySelector('.words'); window.__tb = __b.dataset.token`);
  const pick = (who) => p.ev(`[...${who}.querySelectorAll('.opt')].findIndex((o) => o.getAttribute('aria-checked') === 'true')`);
  const lean = [await pick('__a'), await pick('__b')];
  await p.ev(`__b.querySelector('.words').focus()`);
  await p.type('words for B');
  await p.ev(`__bw.setSelectionRange(3, 5)`);
  await p.ev(`__a.querySelector('.words').focus()`);
  await p.type('words for A');
  ra.cancel(ida);
  await p.until(`document.querySelectorAll('.q').length === 1`);
  for (const ch of '3x') await p.key(ch);
  await sleep(200);
  const b = JSON.parse(await p.ev(`JSON.stringify({ same: document.querySelector('.q .words') === __bw, value: __bw.value, sel: [__bw.selectionStart, __bw.selectionEnd],
    unsent: [...document.querySelectorAll('.unsent pre')].map((e) => e.textContent), pick: [...document.querySelector('.q').querySelectorAll('.opt')].findIndex((o) => o.getAttribute('aria-checked') === 'true') })`));
  check('A\'s re-ask leans to South and B, asking the same id, leans to nothing', lean[0] === 1 && lean[1] === -1, JSON.stringify(lean));
  check('cancelling A keeps B\'s words and caret, shows A\'s as unsent, and keys typed after A left do nothing',
    b.same && b.value === 'words for B' && b.sel.join() === '3,5' && JSON.stringify(b.unsent) === '["words for A"]' && b.pick === -1, JSON.stringify(b));
  const tb = await p.ev('__tb');
  const res = await fetch(`${base}/api/q/${tb}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'defer', words: 'from the phone' }) });
  const ans = await rb.reply(idb);
  check('B answered over HTTP, as the phone would, reaches B alone', res.status === 200 && ans?.kind === 'defer' && ans.words === 'from the phone' && await ra.reply(ida, 300) === null,
    `${res.status} ${JSON.stringify(ans)}`);
}

// --- reports: a session's reports on its page, diagrams drawn -----------------
if (run('report')) {
  const port = 4323;
  const { f, p: bp } = await fresh(port, ['A']);
  const base = `http://127.0.0.1:${port}`;
  const sp = await tab(`${base}/s/rep-1`);
  await sp.ev('window.__loaded = 1');
  await bp.send('Page.bringToFront');
  const row = '#side a.item.report[data-session="rep-1"]';
  const dotted = `!!document.querySelector('${row} .dot')`;
  const r = relay(port, 'rep-1');
  r.report('## First\n\n```mermaid\nflowchart LR\n  A --> B\n```');
  const drawn = await sp.until(`!!document.querySelector('.reports article svg')`, 20000) >= 0;
  const hidden = await sp.ev(`document.visibilityState === 'hidden' && window.__loaded === 1`);
  check('a first report reaches the hidden session tab without a reload, its diagram an SVG, and dots its session on the board tab and its own',
    drawn && hidden && await bp.until(dotted) >= 0 && await sp.ev(dotted), `drawn=${drawn} hidden=${hidden} board=${await bp.ev(dotted)} own=${await sp.ev(dotted)}`);
  const under = await bp.ev(`document.querySelector('${row}')?.closest('.group').querySelector('.head').textContent`);
  check('a session that reports with no open question gets its own sidebar row under its project', under === path.basename(dir), under);

  await sp.send('Page.bringToFront');
  const cleared = await sp.until(`document.visibilityState === 'visible' && !!document.querySelector('${row}') && !${dotted}`) >= 0;
  await bp.send('Page.bringToFront');
  const boardCleared = await bp.until(`document.visibilityState === 'visible' && !${dotted}`) >= 0;
  await bp.send('Page.reload');
  const reloaded = await bp.until(`!!document.querySelector('${row}')`, 5000) >= 0 && !await bp.ev(dotted);
  check('showing the session page clears the dot, on its tab and on the board tab, and a reload keeps it clear',
    cleared && boardCleared && reloaded, `cleared=${cleared} board=${boardCleared} reloaded=${reloaded}`);

  const t1 = await sp.ev(`document.querySelector('.reports article').dataset.time`);
  await sp.ev(`document.querySelector('.reports article svg').__mark = 1`);
  r.report('## Second\n\n```mermaid\nflowchart LR\n  C --> D\n```');
  const back = await bp.until(dotted, 5000) >= 0;
  const both = await sp.until(`document.querySelectorAll('.reports article svg').length === 2`, 20000) >= 0;
  const kept = await sp.ev(`document.querySelector('.reports article[data-time="${t1}"] svg')?.__mark === 1 && document.querySelector('.reports article').dataset.time !== '${t1}'`);
  check('a newer report with the session page hidden dots it again, lands above the first, and the first\'s diagram is the same node',
    back && both && kept, `back=${back} both=${both} kept=${kept}`);

  // z2a7gdgr's hostile diagrams.
  let hits = 0;
  const detector = http.createServer((req, res) => { hits++; res.end(); });
  await new Promise((done) => detector.listen(4398, '127.0.0.1', done));
  const fence = (src) => '```mermaid\n' + src + '\n```\n\n';
  const control = 'flowchart LR\n  C --> D';
  agent(f, (b) => {
    card(b, 'A').notes = fence(control)
      + fence('%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A["<img src=http://127.0.0.1:4398/a onerror=window.__x=1>"] --> B')
      + fence('flowchart LR\n  A --> B\n  click A "javascript:window.__x=1"');
    card(b, 'A').comments = [comment(fence('sequenceDiagram\n  A->>B: <img src=http://127.0.0.1:4398/c onerror="window.__x=1">')
      + fence('%%{init: {"themeCSS": "* { cursor: url(http://127.0.0.1:4398/t), auto }", "fontFamily": "x; cursor: url(http://127.0.0.1:4398/f), auto"}}%%\nflowchart LR\n  A --> B'))];
  });
  await bp.until(`!!document.querySelector('.card .meta')`);
  await bp.click('.card .t');
  const slots = `(() => { const d = [...document.querySelectorAll('#card .md .diagram')]; return d.length === 5 && d.every((x) => x.querySelector('svg, pre')); })()`;
  const settled = await bp.until(slots, 20000) >= 0;
  await bp.ev(`document.querySelectorAll('#card .md .diagram svg g').forEach((g) => g.dispatchEvent(new MouseEvent('click', { bubbles: true })))`);
  await sleep(1500);
  if (await bp.ev(`document.activeElement.id === 'card-notes'`)) await bp.key('Escape'); // a click on the notes view edits them
  const safe = JSON.parse(await bp.ev(`JSON.stringify({ x: window.__x, onerror: document.querySelectorAll('[onerror]').length, img: document.querySelectorAll('#board img, #card img').length,
    js: document.querySelectorAll('a[href^="javascript" i]').length, control: !!document.querySelector('${notesView} .diagram')?.querySelector('svg'),
    face: !!document.querySelector('.card .b pre > code.language-mermaid') && !document.querySelector('.card .b .diagram') })`));
  check('hostile diagrams in notes and a comment: the control draws, the face shows code, and nothing runs, loads or links to javascript:',
    settled && safe.control && safe.face && safe.x === undefined && safe.onerror === 0 && safe.img === 0 && safe.js === 0 && hits === 0,
    `settled=${settled} ${JSON.stringify(safe)} detector hits=${hits}`);
  detector.close();

  const size = `(() => { const v = document.querySelector('${notesView} .diagram svg')?.viewBox.baseVal; return v ? v.width + 'x' + v.height : ''; })()`;
  const drawnSize = await bp.ev(size);
  await bp.ev(`document.querySelector('${notesView} .diagram svg').__mark = 1`);
  await bp.click(`${notesView} .diagram`);
  check('a click on a diagram in the rendered notes edits their source',
    await bp.ev(`document.activeElement.id === 'card-notes' && ${shown('#card-notes')} && !${shown(notesView)}`),
    await bp.ev(`document.activeElement.id + ' ' + document.activeElement.tagName`));
  // The save landing while they are typed in sets the hidden view's html again.
  await bp.ev(`(() => { const t = document.activeElement; t.setSelectionRange(t.value.length, t.value.length); })()`);
  await bp.type('\n\nmore');
  await saved(bp);
  const replaced = await bp.until(`!document.querySelector('${notesView} .diagram svg')?.__mark`) >= 0;
  await bp.until(`!!document.querySelector('${notesView} .diagram svg')`, 2000); // a draw in the hidden view, if any, ends
  await bp.key('Escape');
  const redrawn = await bp.until(`${shown(notesView)} && ${size} === '${drawnSize}'`, 20000) >= 0;
  check('a diagram in notes typed in while a save lands is drawn at its size once they show again',
    drawnSize && replaced && redrawn, `${drawnSize} -> ${await bp.ev(size)} replaced=${replaced}`);
}

// --- pushes: only what the owner was not shown --------------------------------
// Each "none" row makes a control item on board C, which
// no tab shows, and asserts only once the control's push has arrived.
if (run('push')) {
  const port = 4322;
  const pdir = path.join(dir, 'push');
  const pbin = path.join(pdir, 'bin');
  fs.mkdirSync(path.join(pdir, '.config', 'claude-notify'), { recursive: true });
  fs.mkdirSync(pbin);
  fs.writeFileSync(path.join(pdir, '.config', 'claude-notify', 'topic'), 'e2e\n');
  fs.writeFileSync(path.join(pbin, 'tailscale'), '#!/bin/sh\necho 127.0.0.2\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pbin, 'pidof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); // no hyprlock
  const posts = [];
  const ntfy = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { posts.push({ path: req.url, click: req.headers.click, body }); res.end(); });
  });
  await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
  const penv = { ...env, HOME: pdir, XDG_CONFIG_HOME: pdir, PATH: `${pbin}:${env.PATH}`, KBAN_PUSH_DELAY: '3s', KBAN_NTFY: `http://127.0.0.1:${ntfy.address().port}/` };
  const cols = (titles, todo = []) => ({ instructions: 'test', columns: titles.map((title, i) => ({ title, cards: i ? [] : todo.map((t) => ({ id: `id-${t}`, title: t })) })) });
  const files = { A: cols(['Todo', 'Doing', 'Building', 'Blocked', 'Waiting', 'Review'], ['A1']), B: cols(['Todo', 'Review'], ['B1']), C: cols(['Todo', 'Approve']) };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(pdir, `${n}.json`), JSON.stringify(b, null, 2));
  const [fA, fB, fC] = ['A', 'B', 'C'].map((n) => path.join(pdir, `${n}.json`));
  const url = await server(fA, port, false, penv);
  const k = procs.at(-1);
  const idA = url.split('/').at(-1);
  const idB = join(fB, port, penv).id;
  const idC = join(fC, port, penv).id;
  const tail = `http://127.0.0.2:${port}`;
  const link = (id, card) => `${tail}/b/${id}#card=${card}`;
  const add = (f, col, title) => spawnSync(bin, ['add', '-f', f, col, title], { encoding: 'utf8' }).stdout.trim();
  const posted = (l) => posts.filter((x) => x.click === l).length;
  const arrives = async (l, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (posted(l)) return true; return false; };
  let n = 0;
  const control = () => arrives(link(idC, add(fC, 'Approve', `control ${++n}`)), 10000);
  const p = await tab(url);
  await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const card = async (title) => {
    const id = add(fA, 'Todo', title);
    await p.until(`!!document.querySelector('.card[data-id="${id}"]')`);
    return id;
  };
  const onScreen = (c) => `(() => { const r = document.querySelector('.col[data-c="${c}"]').getBoundingClientRect(); return r.left + r.width / 2 >= 0 && r.right - r.width / 2 <= innerWidth; })()`;

  let x = await card('X1');
  const off = await p.ev(`${onScreen(0)} && !${onScreen(5)} && document.hasFocus() && document.visibilityState === 'visible'`);
  kban('move', '-f', fA, x, 'Review');
  const x1 = x;
  check('a card moved into an off-screen Review pushes its tailnet link and title',
    off && await arrives(link(idA, x)) && posts.find((q) => q.click === link(idA, x1)).body.includes('X1') && posts[0].path === '/e2e', `off=${off} ${JSON.stringify(posts)}`);

  // A column title being edited holds the board on screen: the card still shows in Todo.
  x = await card('Held');
  await p.click('.col[data-c="0"] .col-head .t');
  const editing = await p.ev(`!!document.querySelector('.col-head input')`);
  kban('move', '-f', fA, x, 'Review');
  check('a card moved while the screen holds an older board: a push', editing && await arrives(link(idA, x)), `editing=${editing}`);
  await p.key('Escape');

  x = await card('X2');
  kban('move', '-f', fA, x, 'Review');
  await sleep(800);
  for (let i = 0; i < 5; i++) await p.key('l');
  const into = await p.until(onScreen(5)) >= 0;
  check('Review scrolled into view before the delay: no push', into && await control() && !posted(link(idA, x)), `into=${into} ${JSON.stringify(posts)}`);

  x = await card('X3');
  kban('move', '-f', fA, x, 'Review');
  check('a card moved into Review on screen: no push', await p.ev(onScreen(5)) && await control() && !posted(link(idA, x)));

  await p.ev(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))`);
  x = await card('X4');
  kban('move', '-f', fA, x, 'Review');
  check('the page hidden: a push', await arrives(link(idA, x)));
  await p.ev(`delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'))`);

  await p.ev(`document.hasFocus = () => false; dispatchEvent(new Event('blur'))`);
  x = await card('X5');
  kban('move', '-f', fA, x, 'Review');
  check('the page visible but unfocused: a push', await arrives(link(idA, x)));
  x = await card('X6');
  kban('move', '-f', fA, x, 'Review');
  await sleep(1000);
  await p.ev(`delete document.hasFocus; dispatchEvent(new Event('focus'))`);
  check('focused again before the delay: no push', await p.ev('document.hasFocus()') && await control() && !posted(link(idA, x)));

  const y1 = add(fB, 'Todo', 'Y1');
  kban('move', '-f', fB, y1, 'Review');
  await p.click(entry(idB));
  const onB = await p.until(`location.pathname === '/b/${idB}' && !!document.querySelector('.card[data-id="${y1}"]')`, 5000) >= 0;
  check('a sidebar click to the board before the delay: no push', onB && await control() && !posted(link(idB, y1)), `onB=${onB}`);

  await p.click('.card[data-id="id-B1"]');
  const modal = await p.until(`document.querySelector('#card').open`) >= 0;
  const y2 = add(fB, 'Todo', 'Y2');
  kban('move', '-f', fB, y2, 'Review');
  check('the modal open over a Review card: a push', modal && await arrives(link(idB, y2)) && await p.ev(`!!document.querySelector('.card[data-id="${y2}"]')`));
  await p.ev(`document.querySelector('#card').close()`);

  const r1 = relay(port, 'push-1');
  const ask1 = r1.ask(small('P1', ['Yes', 'No']));
  const row = await p.until(`!!document.querySelector('#side .item.ask[data-token]')`) >= 0;
  check('a question reaching the focused tab\'s sidebar: no push', row && await control() && !posted(`${tail}/s/push-1`), `row=${row}`);
  await p.ev(`document.head.insertAdjacentHTML('beforeend', '<style id="away">#side { padding-top: 3000px }</style>')`);
  const r2 = relay(port, 'push-2');
  const ask2 = r2.ask(small('P2', ['Yes', 'No']));
  check('its sidebar row out of view: a push', await arrives(`${tail}/s/push-2`), JSON.stringify(posts.map((q) => q.click)));
  await p.ev(`document.querySelector('#away').remove()`);
  r1.cancel(ask1);
  r2.cancel(ask2);

  const once = posts.map((q) => q.click).filter((c, i, all) => all.indexOf(c) !== i);
  check('no link pushed twice', !once.length, JSON.stringify(once));

  const q = await tab(`${tail}/b/${idB}`);
  await q.send('Page.navigate', { url: link(idA, x1) }); // the DevTools endpoint drops a URL's fragment
  const opened = await q.until(`document.querySelector('#card').open && document.querySelector('#card-title').value === 'X1'`) >= 0;
  await q.ev(`document.querySelector('#card').close()`);
  k.kill('SIGKILL');
  await new Promise((r) => k.once('exit', r));
  await server(fA, port, false, penv);
  add(fA, 'Todo', 'after the reopen');
  const back = await q.until(`[...document.querySelectorAll('.card .t')].some((e) => e.textContent === 'after the reopen')`, 8000) >= 0;
  check('the push\'s link opens its card; closed, it stays closed after the stream reopens',
    opened && back && await q.ev(`!document.querySelector('#card').open`), `opened=${opened} back=${back}`);
  ntfy.close();
}

// --- screenshots for a look ----------------------------------------------------
if (run('shots')) {
  const { f, p } = await fresh(4307, ['Fix login redirect', 'Write parser', 'Paging off-by-one']);
  agent(f, (b) => {
    const c = card(b, 'Fix login redirect');
    c.notes = 'Bottom line: cookie path was wrong, so the session cookie never reached /app.\nRisk: none\nDiff: 3 files changed, 41 insertions(+), 12 deletions(-)\ntier: 2\nbranch: card/fix-login-redirect';
    c.comments = [comment('Reproduced on staging. The redirect drops the cookie because its path is /auth.'),
      { author: os.userInfo().username, time: '2026-10-15T14:30:00+03:00', text: 'Good catch. Does the fix cover the logout path too?' },
      comment('Yes: logout clears the cookie with the same path now.\nAdded a test for both.')];
  });
  await p.until(`!!document.querySelector('.card .meta')`);
  for (const [w, hgt] of [[1440, 900], [390, 844]]) {
    for (const theme of ['dark', 'light']) {
      await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: w < 500 });
      await p.ev(`document.documentElement.dataset.theme = '${theme}'`);
      await p.ev(`document.querySelector('#card').open || document.querySelectorAll('.card')[0].click()`);
      await sleep(300);
      const shot = await p.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.SHOTS || dir, `modal-${w}-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
      check(`notes show in full at ${w}px ${theme}`, await p.ev(`(() => { const v = document.querySelector('${notesView}'); return !!v && ${shown(notesView)} && v.scrollHeight <= v.clientHeight + 1; })()`));
      const clip = await p.ev(`[...document.querySelectorAll('#card *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && getComputedStyle(e).overflowX !== 'auto' && getComputedStyle(e).overflowX !== 'scroll' && !['svg','path','INPUT','TEXTAREA'].includes(e.tagName)).map((e) => (e.id || e.className) + ':' + e.scrollWidth + '/' + e.clientWidth).join(' ')`);
      check(`no clipped element in the modal at ${w}px ${theme}`, !clip, clip);
    }
  }
  await p.ev(`document.querySelector('#card').close()`);
  await sleep(200);
  const shot = await p.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.SHOTS || dir, `board-390-light.png`), Buffer.from(shot.result.data, 'base64'));
  console.log('screenshots in', process.env.SHOTS || dir);
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
