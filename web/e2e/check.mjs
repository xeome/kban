// Drives the real kban binary and the real UI in headless Chromium over CDP.
// usage: bun web/e2e/check.mjs <kban binary> [only-step]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

async function server(file, port) {
  const p = spawn(bin, ['-no-open', '-p', String(port), file], { stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  await new Promise((r) => p.stdout.once('data', r));
  return `http://127.0.0.1:${port}`;
}

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
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && wait.has(msg.id)) { wait.get(msg.id)(msg); wait.delete(msg.id); }
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
      await until('document.readyState === "complete" && !!document.querySelector(".col, #problem:not([hidden])")', 5000);
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
      return { send, ev, key, type, until, click };
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
const comment = (text) => ({ author: 'claude', time: '2026-10-15T14:02:00+03:00', text });
const board = (todo) => ({ instructions: 'test', columns: [
  { title: 'Todo', cards: todo.map((t) => ({ title: t, notes: `notes of ${t}` })) }, { title: 'Doing', cards: [] }, { title: 'Done', cards: [] }] });
// past the 300ms save debounce, then until the save has landed
const saved = async (p) => { await sleep(400); return p.until('document.querySelector("#status").dataset.state === "saved" && document.querySelector("#status").textContent === "saved"', 4000); };

async function fresh(port, todo) {
  const f = path.join(dir, `b${port}.json`);
  fs.writeFileSync(f, JSON.stringify(board(todo), null, 2));
  const url = await server(f, port);
  const p = await tab(url);
  await p.until(`document.querySelectorAll('.card').length === ${todo.length}`);
  return { f, p };
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
  agent(f, (b) => b.columns[0].cards.unshift({ title: 'Z' }));
  await p.until(`document.querySelectorAll('.card').length === 3`);
  check('the modal still shows its card after one is inserted above', await p.ev(`document.querySelector('#card-title').value === 'B' && document.querySelector('#card-where').textContent.includes('3 of 3')`));
  await p.ev(`document.querySelector('#card-draft').focus()`);
  await p.type('on B');
  await p.key('Enter', { ctrl: true });
  await saved(p);
  check('a comment posted from the modal lands on the open card', JSON.stringify(card(read(f), 'B').comments?.map((c) => c.text)) === '["on B"]' && !card(read(f), 'Z').comments && !card(read(f), 'A').comments);
  check('the posted comment carries the server user and an offset time', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(card(read(f), 'B').comments[0].time) && card(read(f), 'B').comments[0].author === os.userInfo().username);
  await p.ev(`document.querySelector('#card-draft').focus()`);
  await p.type('half-written');
  await p.ev(`document.querySelector('#card-title').focus(); document.querySelector('#card-title').select()`);
  await p.type('B renamed');
  await p.key('Enter');
  await p.key('ArrowUp', { ctrl: true });
  await p.key('ArrowDown', { ctrl: true });
  check('a draft follows its card through a rename', await p.ev(`document.querySelector('#card-title').value === 'B renamed' && document.querySelector('#card-draft').value === 'half-written'`),
    await p.ev(`document.querySelector('#card-title').value + ' / ' + document.querySelector('#card-draft').value`));
}

// --- u reverts only my last action --------------------------------------
if (run('undo-a') || run('undo')) {
  const { f, p } = await fresh(4304, ['A', 'B']);
  await p.ev(`document.querySelector('#board').focus?.(); document.activeElement.blur()`);
  await p.key('ArrowDown'); // select A
  await p.key('ArrowRight', { shift: true }); // move A to Doing
  await saved(p);
  check('(a) setup: the move reached the file', read(f).columns[1].cards[0]?.title === 'A');
  agent(f, (b) => { b.columns[0].cards.push({ title: 'agent card' }); card(b, 'B').comments = [comment('agent note')]; });
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
  check('(c) setup: the rename reached the file', !!card(read(f), 'Y2'));
  agent(f, (b) => (card(b, 'Y2').comments = [comment('agent on Y2')]));
  await p.until(`[...document.querySelectorAll('.comment-text')].some((e) => e.textContent.trim() === 'agent on Y2')`);
  await p.key('u');
  await saved(p);
  await sleep(200);
  const y = card(read(f), 'Y');
  check('(c) undo of a rename restores the title and keeps the comment', !card(read(f), 'Y2') && y?.comments?.length === 1, JSON.stringify(read(f).columns[0]));
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
  fs.writeFileSync(f, JSON.stringify({ columns: Array.from({ length: 9 }, (_, c) => ({ title: `C${c}`, cards: [{ title: `x${c}`, notes: '**x**' }, { title: `y${c}` }] })) }, null, 2));
  const p = await tab(await server(f, 4311));
  await p.until(`document.querySelectorAll('.card').length === 18`);
  // The stream's onopen loads the board again, and that render scrolls the
  // selected card into view: let it land before scrolling away from it.
  await p.until(`document.querySelector('#status').dataset.state === 'saved'`);
  await sleep(500);
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
    await p.ev(`document.activeElement.id !== 'card-notes' && ${shown(notesView)} && !document.querySelector('.notes.held')`),
    await p.ev(`document.activeElement.id + ' held=' + !!document.querySelector('.notes.held')`));
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
