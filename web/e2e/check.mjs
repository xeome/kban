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
const entry = (id) => `#tabs .tab[data-id="${id}"]`;
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
let ran = false;
const run = (name) => !only || (only === name && (ran = true));
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
  await p.ev('new Promise((r) => requestAnimationFrame(r))'); // Chrome fires close in the next frame
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
if (run('undo')) {
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
  {
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
  const url = await p.ev('location.href');
  // A board page asks for its board as it unloads: let that go before Fetch.enable.
  await p.send('Page.navigate', { url: 'about:blank' });
  await p.until('location.href === "about:blank"');
  let asked = 0;
  p.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId } = m.params;
    if (asked++) p.send('Fetch.continueRequest', { requestId });
    else p.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
  });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/board' }] });
  await p.send('Page.navigate', { url });
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
  check('the board clicked has lost its dot, and the header names its project',
    await p.until(`!!document.querySelector('${entry(b.id)}') && !${dot(b.id)}`) >= 0 && await p.ev(`document.querySelector('#file').textContent`) === path.basename(dir),
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

// --- ask: an agent session's question, answered in the hub ---------------------
function relay(port, session, cwd = dir) {
  const p = spawn(bin, ['mcp', '-p', String(port)], { env: { ...env, CLAUDE_CODE_SESSION_ID: session }, cwd, stdio: ['pipe', 'pipe', 'inherit'] });
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
const small = (id, labels, hard = false) => ({ id, task: 'questions in the hub', question: `Which way for ${id}?`,
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

if (run('ask')) {
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
  const badge = await board.until(`!!document.querySelector('#side .item .badge')`, 3000);
  const project = await board.ev(`[...document.querySelectorAll('#side .item')].find((r) => r.querySelector('.badge'))?.querySelector('.label').textContent`);
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
  check('the header names the project, the heading the task, and the page is the session\'s',
    await p.ev(`document.querySelector('#file').textContent`) === path.basename(dir) && await p.ev(`document.querySelector('#sess .who h2')?.textContent`) === 'session store'
      && (await p.ev('document.title')).startsWith('● session store'),
    await p.ev(`document.querySelector('#file').textContent + ' | ' + document.querySelector('#sess .who h2')?.textContent + ' | ' + document.title`));

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
  const hardLean = [await pressed('K2'), await p.ev(`${q1('K2')}.querySelector('.echo').textContent`), await p.ev(`${q1('K2')}.querySelector('.pill')?.textContent`)];
  await p.click('.opt[data-i="1"]');
  await p.ev(`${q1('K2')}.querySelector('.answer .primary').click()`);
  a = await r.reply(rid);
  check('a hard-to-undo re-ask shows its pill, names the lean but picks nothing, and Send with a bare pick is accepted',
    hardLean[0] === -1 && hardLean[1].includes('South') && hardLean[2] === 'Hard to undo' && a?.kind === 'option' && a.option === 'B' && a.label === 'South' && a.words === '',
    JSON.stringify(hardLean) + ' ' + JSON.stringify(a));

  rid = await show(small('K2', ['North', 'South'], true));
  await p.ev(`${q1('K2')}.querySelector('[data-p="text"]').click()`);
  await p.ev(`${q1('K2')}.querySelector('.answer .primary').click()`);
  const refused = await p.until(`${q1('K2')}?.querySelector('.status').textContent.includes('Write your answer')`);
  check('None of these with no words shows the server\'s refusal on the question, which stays open',
    refused >= 0 && await r.reply(rid, 500) === null && await p.ev(`!!${q1('K2')}`),
    await p.ev(`${q1('K2')}?.querySelector('.status').textContent`));
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
if (run('ask2')) {
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
  check('B answered over HTTP, as the phone would, reaches B', res.status === 200 && ans?.kind === 'defer' && ans.words === 'from the phone',
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
  const row = '#list .item[data-session="rep-1"]';
  const dotted = `!!document.querySelector('${row} .dot')`;
  const projectRow = `#side .item[data-project="${path.basename(dir)}"]`;
  const projectDotted = `!!document.querySelector('${projectRow} .dot')`;
  const r = relay(port, 'rep-1');
  const fence = (src) => '```mermaid\n' + src + '\n```\n\n';
  r.report('## First\n\n```mermaid\nflowchart LR\n  A --> B\n```');
  const drawn = await sp.until(`!!document.querySelector('.reports article svg')`, 20000) >= 0;
  const hidden = await sp.ev(`document.visibilityState === 'hidden' && window.__loaded === 1`);
  check('a first report reaches the hidden session tab without a reload, its diagram an SVG, and dots its project on the board tab and its Sessions row on its own',
    drawn && hidden && await bp.until(projectDotted) >= 0 && await sp.ev(dotted), `drawn=${drawn} hidden=${hidden} board=${await bp.ev(projectDotted)} own=${await sp.ev(dotted)}`);
  const under = await sp.ev(`document.querySelector('${row}') && document.querySelector('#side .item[aria-current="page"]')?.dataset.project`);
  check('a session that reports with no open question gets its own row in its project\'s Sessions list', under === path.basename(dir), under);

  await sp.send('Page.bringToFront');
  const cleared = await sp.until(`document.visibilityState === 'visible' && !!document.querySelector('${row}') && !${dotted}`) >= 0;
  await bp.send('Page.bringToFront');
  const boardCleared = await bp.until(`document.visibilityState === 'visible' && !${projectDotted}`) >= 0;
  await bp.send('Page.reload');
  const reloaded = await bp.until(`!!document.querySelector('${projectRow}')`, 5000) >= 0 && !await bp.ev(projectDotted);
  check('showing the session page clears the dot, on its tab and on the board tab\'s project row, and a reload keeps it clear',
    cleared && boardCleared && reloaded, `cleared=${cleared} board=${boardCleared} reloaded=${reloaded}`);

  const t1 = await sp.ev(`document.querySelector('.reports article').dataset.time`);
  await sp.ev(`document.querySelector('.reports article svg').__mark = 1`);
  r.report('## Second\n\n```mermaid\nflowchart LR\n  C --> D\n```');
  const back = await bp.until(projectDotted, 5000) >= 0;
  const both = await sp.until(`document.querySelectorAll('.reports article svg').length === 2`, 20000) >= 0;
  const kept = await sp.ev(`document.querySelector('.reports article[data-time="${t1}"] svg')?.__mark === 1 && document.querySelector('.reports article').dataset.time !== '${t1}'`);
  check('a newer report with the session page hidden dots it again, lands above the first, and the first\'s diagram is the same node',
    back && both && kept, `back=${back} both=${both} kept=${kept}`);

  // The icon rule's stroke reached into diagrams: it outlined flowchart labels and stroked an icon
  // node's own svg. Mermaid's neo look shadows flowchart nodes and sequence participants. So the
  // flowchart backs both halves, the sequence diagram only the shadow one: Mermaid unstrokes its labels.
  r.report(fence('sequenceDiagram\n  participant A as Agent\n  participant H as Hub\n  A->>H: ask\n  H-->>A: answer')
    + fence('flowchart TD\n  A@{ icon: "fa:user", form: "square", label: "User" } --> B[hub]'));
  const mine = `document.querySelector('.reports article')`;
  const two = await sp.until(`${mine}.querySelectorAll('.diagram').length === 2 && !${mine}.querySelector('.diagram .wait')`, 20000) >= 0;
  const plain = JSON.parse(await sp.ev(`(() => { const a = ${mine}, all = [...a.querySelectorAll('.diagram svg, .diagram svg *')];
    const glyphs = all.filter((e) => /^(text|tspan)$/.test(e.tagName) && [...e.childNodes].some((c) => c.nodeType === 3 && c.data.trim()));
    return JSON.stringify({ stroked: glyphs.filter((e) => getComputedStyle(e).stroke !== 'none').length, glyphs: glyphs.length,
      shadowed: all.filter((e) => getComputedStyle(e).filter !== 'none').length, seq: !!a.querySelector('.diagram svg .actor'),
      icons: [...a.querySelectorAll('.diagram svg svg')].map((e) => getComputedStyle(e).stroke) }); })()`));
  check('a flowchart\'s labels and icon draw with no outline, and neither it nor a sequence diagram has a shadow',
    two && plain.stroked === 0 && plain.glyphs > 0 && plain.shadowed === 0 && plain.seq && plain.icons.length > 0 && plain.icons.every((s) => s === 'none'),
    `two=${two} ${JSON.stringify(plain)}`);

  // z2a7gdgr's hostile diagrams.
  let hits = 0;
  const detector = http.createServer((req, res) => { hits++; res.end(); });
  await new Promise((done) => detector.listen(4398, '127.0.0.1', done));
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

// --- the sidebar lists projects; a project opens on a tab bar -----------------
if (run('projects')) {
  const port = 4325;
  const base = `http://127.0.0.1:${port}`;
  const root = fs.mkdtempSync(path.join(dir, 'projects-'));
  const penv = { ...env, XDG_CONFIG_HOME: root };
  const [P, Q, R] = ['app', 'site', 'tools'].map((d) => path.join(root, d));
  for (const d of [P, Q, R]) fs.mkdirSync(d);
  spawnSync('git', ['init', '-q', '-b', 'main', P]);
  const [fA, fB, fC] = [path.join(P, 'A.json'), path.join(P, 'B.json'), path.join(Q, 'C.json')];
  for (const f of [fA, fB, fC]) fs.writeFileSync(f, JSON.stringify(board(['x']), null, 2));
  const C = (await server(fC, port, false, penv)).split('/').at(-1);
  const A = join(fA, port, penv).id;
  const B = join(fB, port, penv).id;
  const row = (name) => `#side .item[data-project="${name}"]`;
  const tabOf = (id) => `#tabs .tab[data-id="${id}"]`;
  const sessTab = '#tabs .tab[data-tab="sessions"]';
  const item = (s) => `#list .item[data-session="${s}"]`;
  const lit = (sel) => `!!document.querySelector('${sel} .dot')`;
  const badge = (name) => `document.querySelector('${row(name)} .badge')?.textContent`;

  // Each report is shown once, so it starts read: a dot below is news.
  const [r1, r2, rt] = [relay(port, 'r1', P), relay(port, 'r2', P), relay(port, 'rt', R)];
  r1.report('First report');
  const p = await tab(`${base}/s/r1`);
  const nav = async (u) => { await p.send('Page.navigate', { url: base + u }); await p.until(`location.pathname === '${u}' && document.readyState === 'complete'`); };
  await p.until(`!!document.querySelector('.reports article')`);
  r2.report('\n## Second report\n\nmore');
  await nav('/s/r2');
  await p.until(`!!document.querySelector('.reports article')`);
  rt.report('tools report');
  await nav(`/b/${C}`);
  const at = async (sel, u) => await p.click(sel) && await p.until(`location.pathname === '${u}' && document.readyState === 'complete' && !!document.querySelector('${row('app')}')`, 5000) >= 0;

  const rows = await p.until(`document.querySelectorAll('#groups > *').length === 3`) >= 0
    && await p.ev(`[...document.querySelectorAll('#groups > *')].map((e) => e.matches('.item[data-project]') ? e.dataset.project : 'not a project row: ' + e.className).sort().join()`);
  check('the sidebar holds project rows only', rows === 'app,site,tools', rows);
  const tabs = `[...document.querySelectorAll('#tabs .tab')].map((t) => (t.dataset.id ? t.querySelector('.file').textContent : t.textContent) + (t.getAttribute('aria-current') === 'page' ? '*' : '')).join()`;
  check('a board-only project has no Sessions tab, and /b/{id} selects its tab', await p.ev(tabs) === 'C.json*', await p.ev(tabs));

  check('a project with no board opens its first session', await at(row('tools'), '/s/rt'), await p.ev('location.pathname'));
  await at(row('app'), `/b/${A}`);
  await at(tabOf(B), `/b/${B}`);
  check('/b/{id} selects its board\'s tab', await p.ev(tabs) === 'A.json,B.json*,Sessions', await p.ev(tabs));
  await at(row('site'), `/b/${C}`);
  check('a project opens on the tab last open in it, before its first board', await at(row('app'), `/b/${B}`), await p.ev('location.pathname'));

  const rw = relay(port, 'w', P);
  const askW = rw.ask(small('W1', ['Yes', 'No']));
  await at(row('site'), `/b/${C}`);
  await p.until(`${badge('app')} === '?'`);
  check('a project opens on a waiting question, before the tab last open in it', await at(row('app'), '/s/w'), await p.ev('location.pathname'));
  check('a click opens the project with its board tabs and one Sessions tab, which /s/{session} selects',
    await p.ev(tabs) === 'A.json,B.json,Sessions?*', await p.ev(tabs));
  const list = await p.ev(`JSON.stringify([...document.querySelectorAll('#list .item')].map((e) => [e.dataset.session, e.querySelector('.label').textContent, e.querySelector('small').textContent]))`);
  const [w, s2, s1] = JSON.parse(list);
  check('the list puts the waiting session first, then the newest report; each row reads its task or first line, then time and branch',
    w?.join() === 'w,questions in the hub,main' && s2?.[0] === 'r2' && s2[1] === 'Second report' && / · main$/.test(s2[2]) && s2[2] !== ' · main'
      && s1?.slice(0, 2).join() === 'r1,First report' && JSON.parse(list).length === 3, list);
  check('the Sessions tab links to the list\'s first row',
    await p.ev(`!!document.querySelector('${sessTab}') && document.querySelector('${sessTab}').getAttribute('href') === document.querySelector('#list .item')?.getAttribute('href')`));

  const rw2 = relay(port, 'w2', P);
  const askW2 = rw2.ask(small('W2', ['Yes', 'No']));
  check('a second question in the project turns its ? into ?2', await p.until(`${badge('app')} === '?2'`) >= 0, await p.ev(badge('app')));
  rw.cancel(askW);
  await p.until(`${badge('app')} === '?'`);

  await at(row('site'), `/b/${C}`);
  kban('add', '-f', fA, 'Todo', 'agent on A');
  const rowLit = await p.until(lit(row('app'))) >= 0;
  await at(row('app'), '/s/w2');
  const tabLit = await p.until(lit(tabOf(A))) >= 0 && await p.ev(lit(row('app')));
  await at(tabOf(A), `/b/${A}`);
  const cleared = await p.until(`!${lit(tabOf(A))} && !${lit(row('app'))}`) >= 0;
  check('an agent\'s edit to a board in another project lights its project row and its tab, and showing the board clears both',
    rowLit && tabLit && cleared, `row=${rowLit} tab=${tabLit} cleared=${cleared}`);

  r1.report('Third report');
  const news = await p.until(`${lit(row('app'))} && ${lit(sessTab)}`) >= 0;
  await at(sessTab, '/s/w2');
  const listed = await p.until(`${lit(item('r1'))} && ${lit(sessTab)} && ${lit(row('app'))}`) >= 0;
  await at(item('r1'), '/s/r1');
  const read = await p.until(`!${lit(item('r1'))} && !${lit(sessTab)} && !${lit(row('app'))}`) >= 0;
  check('a new report lights the project row, the Sessions tab and its row, and showing the session clears them',
    news && listed && read, `news=${news} listed=${listed} read=${read}`);

  await at(tabOf(B), `/b/${B}`);
  rw2.cancel(askW2);
  await at(row('site'), `/b/${C}`);
  fs.writeFileSync(path.join(root, 'kban', 'boards'), [fC, fA].join('\n') + '\n');
  await p.until(`fetch('/api/b/${B}/board').then((r) => r.status === 404)`);
  await p.until(`!document.querySelector('${row('app')} .badge')`);
  check('a project whose last tab is no longer listed opens its first board', await at(row('app'), `/b/${A}`), await p.ev('location.pathname'));
}

// --- pushes: only what the owner was not shown --------------------------------
// Each "none" row asks a control question whose project row is hidden, so
// no tab shows it, and asserts only once the control's push has arrived.
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
  const fA = path.join(pdir, 'A.json');
  fs.writeFileSync(fA, JSON.stringify({ instructions: 'test', columns: [{ title: 'Todo', cards: [] }] }, null, 2));
  const url = await server(fA, port, false, penv);
  const tail = `http://127.0.0.2:${port}`;
  const posted = (l) => posts.filter((x) => x.click === l).length;
  const arrives = async (l, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (posted(l)) return true; return false; };
  // Each control asks from its own directory, so its project row is a new
  // element, not the questions' shown row, which the tab already counts as
  // seen. It comes due up to a tick after the item it controls, and both may
  // post at once, so pushed() waits a tick more before a row reads posted().
  let n = 0;
  const control = (proj) => {
    const i = ++n;
    proj ??= `unseen-${i}`;
    const cwd = path.join(pdir, proj);
    fs.mkdirSync(cwd, { recursive: true });
    const r = relay(port, `unseen-${i}`, cwd);
    const ask = r.ask(small(`C${i}`, ['Yes', 'No']));
    return {
      asked: () => p.until(`!!document.querySelector('#side .item[data-project="${proj}"]')?.dataset.tokens`),
      pushed: async () => { const got = await arrives(`${tail}/s/unseen-${i}`, 10000); await sleep(600); r.cancel(ask); return got; },
    };
  };
  const p = await tab(url);
  await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await p.ev(`document.head.insertAdjacentHTML('beforeend', '<style>#side .item[data-project^="unseen-"] { display: none }</style>')`);
  // Every push-N asks from dir, one project, so its row holds them all.
  const asks = [];
  const question = async (i) => {
    const r = relay(port, `push-${i}`);
    asks.push([r, r.ask(small(`P${i}`, ['Yes', 'No']))]);
    return await p.until(`document.querySelector('#side .item[data-project="${path.basename(dir)}"]')?.dataset.tokens.split(' ').length === ${i}`) >= 0;
  };
  const link = (i) => `${tail}/s/push-${i}`;
  const clicks = () => JSON.stringify(posts.map((q) => q.click));

  const row = await question(1);
  check('a question reaching the focused tab\'s sidebar: no push', row && await control().pushed() && !posted(link(1)), `row=${row} ${clicks()}`);

  await p.ev(`document.head.insertAdjacentHTML('beforeend', '<style id="away">#side { padding-top: 3000px }</style>')`);
  await question(2);
  check('its sidebar row out of view: a push of the question to the topic',
    await arrives(link(2)) && posts.some((q) => q.click === link(2) && q.path === '/e2e' && q.body.includes('Which way for P2?')), JSON.stringify(posts));
  // The control's own stream event comes before the row scrolls in, so only the scroll tells.
  await question(3);
  let c = control();
  await c.asked();
  await p.ev(`document.querySelector('#away').remove()`);
  check('its row scrolled into view before the delay: no push', await c.pushed() && !posted(link(3)), clicks());

  await p.ev(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))`);
  await question(4);
  check('the page hidden: a push', await arrives(link(4)), clicks());
  await p.ev(`delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'))`);

  await p.ev(`document.hasFocus = () => false; dispatchEvent(new Event('blur'))`);
  await question(5);
  check('the page visible but unfocused: a push', await arrives(link(5)), clicks());
  await question(6);
  c = control();
  await c.asked();
  await sleep(1000);
  await p.ev(`delete document.hasFocus; dispatchEvent(new Event('focus'))`);
  check('focused again before the delay: no push', await p.ev('document.hasFocus()') && await c.pushed() && !posted(link(6)), clicks());

  const m = spawnSync(bin, ['add', '-f', fA, 'Todo', 'M1'], { encoding: 'utf8' }).stdout.trim();
  await p.until(`!!document.querySelector('.card[data-id="${m}"]')`);
  await p.click(`.card[data-id="${m}"]`);
  const modal = await p.until(`document.querySelector('#card').open`) >= 0;
  await question(7);
  check('the card modal open over the sidebar: a push', modal && await arrives(link(7)), `modal=${modal} ${clicks()}`);
  await p.ev(`document.querySelector('#card').close()`);
  await question(8);
  c = control('unseen-3'); // a row already drawn: a new one makes the tab tell all it shows
  await c.asked();
  check('a second question in a project whose row is on screen: no push', await c.pushed() && !posted(link(8)), clicks());
  for (const [r, ask] of asks) r.cancel(ask);
  ntfy.close();
}

// --- the sidebar folds to a rail -----------------------------------------------
if (run('fold')) {
  // Its own registry, so the rail holds two boards, not every step's.
  const port = 4324;
  const fdir = fs.mkdtempSync(path.join(dir, 'fold-'));
  const fenv = { ...env, XDG_CONFIG_HOME: fdir };
  const fA = path.join(fdir, 'A.json');
  const other = path.join(fdir, 'other.json');
  fs.writeFileSync(fA, JSON.stringify(board(['A1']), null, 2));
  fs.writeFileSync(other, JSON.stringify(board(['B1']), null, 2));
  const p = await tab(await server(fA, port, false, fenv));
  await p.ev(`document.documentElement.dataset.theme = 'dark'`);
  const b = join(other, port, fenv);
  const r = relay(port, 'fold-1');
  const ask = r.ask(small('F1', ['Yes', 'No']));
  const asked = `#side .item[data-project="${path.basename(dir)}"]`;
  const boards = `#side .item[data-project="${path.basename(fdir)}"]`;
  const ready = await p.until(`!!document.querySelector('${asked} .badge') && !!document.querySelector('${entry(b.id)}')`) >= 0 && kban('add', '-f', other, 'Todo', 'agent on B');
  check('fold setup: a project row with a question and one with a changed board', ready && await p.until(`!!document.querySelector('${boards} .dot')`) >= 0);

  const W = `document.querySelector('#side').getBoundingClientRect().width`;
  const openW = await p.ev(W); // open by default, checked next
  const is = async (open) => await p.until(`document.querySelector('#fold')?.getAttribute('aria-expanded') === '${open}'
    && !document.querySelector('#side').getAnimations().length && ${W} ${open ? '===' : '<'} ${openW}`, 1000) >= 0;
  const looks = (sel, prop) => `getComputedStyle(document.querySelector('${sel}'), '::after').${prop}`;
  const label = `getComputedStyle(document.querySelector('${boards} .label')).opacity`;
  const state = () => p.ev(`${W} + 'px expanded=' + document.querySelector('#fold')?.getAttribute('aria-expanded') + ' label=' + ${label}`);
  const shoot = async (name) => fs.writeFileSync(path.join(process.env.SHOTS || dir, name), Buffer.from((await p.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  const bracket = async () => {
    for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, ...(type === 'keyDown' ? { text: '[' } : {}) });
  };

  check('open by default: labels shown, the toggle says it collapses, no rail tooltip',
    await is(true) && await p.ev(label) === '1' && await p.ev(looks(boards, 'content')) === 'none', await state());
  await shoot('side-open-1440-dark.png');

  await p.click('#fold');
  check('the toggle folds it to a rail narrower than the open sidebar, with its labels faded', await is(false) && await p.ev(label) === '0', await state());
  const onTile = (row, mark) => p.ev(`(() => {
    const r = document.querySelector('${row}'), m = r?.querySelector('${mark}'), t = r?.querySelector('.tile')?.getBoundingClientRect();
    if (!m || !t) return 'no ${mark} or tile';
    const b = m.getBoundingClientRect(), s = document.querySelector('#side').getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return (b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top && b.right <= s.right + 1
      && m.checkVisibility({ opacityProperty: true }) && m.contains(hit)) || JSON.stringify({ tile: [t.left, t.top, t.right], mark: [b.left, b.top, b.right], rail: s.right });
  })()`);
  let at = await onTile(asked, '.badge');
  check('folded, the question\'s ? badge shows on its project\'s tile', at === true, at);
  at = await onTile(boards, '.dot');
  check('folded, the changed board\'s dot shows on its project\'s tile', at === true, at);

  const [x, y] = await p.ev(`(() => { const t = document.querySelector('${boards} .tile')?.getBoundingClientRect() || document.querySelector('${boards}').getBoundingClientRect(); return [t.left + t.width / 2, t.top + t.height / 2]; })()`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(600); // past the tooltip's .3s delay
  const tip = await p.ev(`${looks(boards, 'content')} + ' opacity=' + ${looks(boards, 'opacity')}`);
  check('folded, hovering a project\'s tile shows a tooltip naming the project', tip.includes(path.basename(fdir)) && tip.endsWith(' opacity=1'), tip);
  await shoot('side-rail-1440-dark.png');
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });

  await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await p.ev(`window.__seen = []; const f1 = window.fetch; window.fetch = (u, o) => { if (u === '/api/seen') window.__seen.push(...JSON.parse(o.body).tokens); return f1(u, o); }`);
  const r2 = relay(port, 'fold-2');
  const ask2 = r2.ask(small('F2', ['Yes', 'No']));
  const told = await p.until(`(() => { const t = document.querySelector('${asked}')?.dataset.tokens.split(' '); return t?.length === 2 && t.every((x) => window.__seen.includes(x)); })()`) >= 0;
  check('folded, a question reaching the rail is posted to /api/seen, so the hub does not push it', told, await p.ev(`JSON.stringify(window.__seen) + ' ' + ${W}`));

  // The tooltip takes hits for the probe, so elementFromPoint finds it beside the rail.
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 100, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const scrolls = await p.ev(`(() => { const s = document.querySelector('#side'), h = [s.scrollHeight, s.clientHeight]; s.scrollTop = s.scrollHeight;
    return (h[0] > h[1] && s.scrollTop > 0) || JSON.stringify({ scrollHeight: h[0], clientHeight: h[1], scrollTop: s.scrollTop }); })()`);
  await p.ev(`document.head.insertAdjacentHTML('beforeend', '<style id="hit">#side.rail .tip::after { pointer-events: auto !important }</style>')`);
  const lastRow = `[...document.querySelectorAll('#groups .item')].at(-1)`;
  const [lx, ly] = await p.ev(`(() => { const t = ${lastRow}.querySelector('.tile').getBoundingClientRect(); return [t.left + t.width / 2, t.top + t.height / 2]; })()`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lx, y: ly });
  await sleep(600);
  const beside = await p.ev(`(() => { const row = ${lastRow}, x = document.querySelector('#side').getBoundingClientRect().right + 20, hit = document.elementFromPoint(x, ${ly});
    return (getComputedStyle(row, '::after').opacity === '1' && row.contains(hit)) || 'at ' + x + ',' + ${ly} + ': ' + (hit?.className || hit?.tagName) + ' ' + (hit?.dataset?.tip || ''); })()`);
  check('folded and taller than the window, the rail scrolls and a hovered tile\'s tooltip shows beside it', scrolls === true && beside === true, `${scrolls} ${beside}`);
  await p.ev(`document.querySelector('#hit').remove(); document.querySelector('#side').scrollTop = 0`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 100 });
  await p.send('Emulation.clearDeviceMetricsOverride');
  r2.cancel(ask2);

  await bracket();
  check('[ unfolds it', await is(true), await state());
  await bracket();
  check('[ folds it again', await is(false), await state());

  await p.ev('window.__old = 1');
  await p.send('Page.reload');
  const reloaded = await p.until(`!window.__old && document.querySelectorAll('.card').length === 1`) >= 0;
  check('the rail survives a reload', reloaded && await is(false), `reloaded=${reloaded} ${await state()}`);

  await p.click('#note');
  await bracket();
  await sleep(400);
  check('[ typed into a field types it and leaves the rail folded',
    await p.ev(`document.querySelector('#note').value.endsWith('[')`) && await is(false), await state());
  await p.ev('document.activeElement.blur()');

  await p.click('#fold');
  check('the toggle unfolds it', await is(true), await state());

  await p.click('#fold');
  await is(false);
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  const strip = await p.ev(`(() => { const r = [...document.querySelectorAll('#groups .item')].map((e) => e.getBoundingClientRect());
    return 'side by side=' + (r.length > 1 && r.every((b, i) => !i || (b.left >= r[i - 1].right && b.top < r[i - 1].bottom)))
      + ' toggle=' + !!document.querySelector('#fold')?.checkVisibility() + ' label=' + ${label}; })()`);
  check('at 390px, folded or not, the sidebar is a strip: project rows side by side, labels shown, no toggle', strip === 'side by side=true toggle=false label=1', strip);
  await p.send('Emulation.clearDeviceMetricsOverride');
  r.cancel(ask);
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
      if (w < 500) check(`notes show in full at ${w}px ${theme}`, await p.ev(`(() => { const v = document.querySelector('${notesView}'); return !!v && ${shown(notesView)} && v.scrollHeight <= v.clientHeight + 1; })()`));
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

if (only && !ran) {
  console.log(`unknown step: ${only}`);
  process.exit(2);
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
