import { h, render as paint } from 'preact';
import { Board, CardBody } from './view.jsx';

const $ = (s) => document.querySelector(s);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// base is the board the server last acknowledged; local edits are relative
// to it. The server merges {base, board} against the file, so this client
// never merges anything itself.
export const S = {
  board: { columns: [] },
  base: null,             // null until the first board: an edit saved against no base replaces every column
  user: '',               // author of comments posted here
  file: '',
  sel: { c: 0, i: -1 },   // i === -1 selects the column header
  edit: null,             // { c, i } for a new card's title, { c } for a column title
  editSnap: null,
  undo: [],               // { before, after } board steps
  dirty: false,
  inflight: false,
  timer: 0,
  open: null,             // id of the card in the modal
  drafts: {},             // unsent comment per card id
  ids: [],                // ids kban made for cards this tab will add
  drag: null,             // { kind: 'card', from: {c, i}, to } | { kind: 'col', from: c, to }
};

// --- server ----------------------------------------------------------------

export async function load() {
  const { file, user, board, error } = await (await fetch('/api/board')).json();
  S.file = file;
  S.user = user;
  $('#file').textContent = file;
  document.title = file;
  receive({ board, error });
  refill();
}

// kban makes every card id. The tab keeps at least 16 in hand, topped up
// after every add, so adding a card never waits on the server: a burst of
// adds outruns a round trip at 4, measured.
let refilling = false;
async function refill() {
  if (S.ids.length >= 16 || refilling) return;
  refilling = true;
  try { S.ids.push(...await (await fetch('/api/ids', { method: 'POST' })).json()); } catch {}
  refilling = false;
}

function receive({ board, error }) {
  problem(error);
  if (board) adopt(board);
}

// Take a server board, unless local edits are pending; the save that
// flushes them will bring the server's state back.
function adopt(board) {
  if (S.dirty || S.inflight || S.edit) return;
  S.board = clone(board);
  S.base = clone(board);
  render();
}

function schedule() {
  S.dirty = true;
  clearTimeout(S.timer);
  S.timer = setTimeout(save, 300);
}

async function send(base, board) {
  const r = await fetch('/api/board', { method: 'PUT', body: JSON.stringify({ base, board }) });
  if (r.status === 409) throw Object.assign(new Error(await r.text()), { unreadable: true });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function save() {
  if (S.inflight) return;
  S.inflight = true;
  S.dirty = false;
  const prevBase = S.base;
  const board = clone(S.board);
  S.base = board;
  status('saving');
  try {
    settle(await send(prevBase, board));
  } catch (e) {
    S.inflight = false;
    S.base = prevBase;
    S.dirty = true;
    failed(e);
    S.timer = setTimeout(save, 2000);
  }
}

function settle(merged) {
  S.inflight = false;
  problem('');
  status('saved');
  if (S.dirty) save();
  else adopt(merged);
}

function failed(e) {
  if (e.unreadable) problem(e.message.trim());
  status('error', e.unreadable ? 'not saved' : 'save failed: ' + e.message);
}

export function listen() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => receive(JSON.parse(e.data));
  es.onopen = () => { status('saved'); load(); };
  es.onerror = () => status('offline');
}

function status(state, text) {
  const el = $('#status');
  el.dataset.state = state;
  el.textContent = text || { saving: 'saving…', saved: 'saved', offline: 'offline' }[state];
}

function problem(error) {
  const el = $('#problem');
  el.hidden = !error;
  el.textContent = error ? `${S.file} can't be read: ${error}. Your changes are kept and will save once it reads again.` : '';
}

// --- theme ---------------------------------------------------------------

// CSS follows the OS until the toggle is clicked; the click is remembered
// on this device.
const root = document.documentElement;
try { if (localStorage.theme) root.dataset.theme = localStorage.theme; } catch {}
$('#theme').addEventListener('click', () => {
  const light = (root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'light';
  root.dataset.theme = light ? 'dark' : 'light';
  try { localStorage.theme = root.dataset.theme; } catch {}
});

// --- note ------------------------------------------------------------------

// The note is the board's instructions. It edits in place: no edit mode,
// and render() leaves it alone while it has focus so typing is never
// clobbered.
const note = $('#note');
note.addEventListener('input', () => {
  S.board.instructions = note.value;
  grow(note);
  schedule();
});

function grow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// --- cards by id ------------------------------------------------------------

// The modal, its drafts and the rendered cards follow a card by its id, the
// identity the server merges by, so they stay on it through an agent's
// rename or move.
export function find(id, b = S.board) {
  for (const [c, col] of b.columns.entries()) {
    for (const [i, card] of col.cards.entries()) if (card.id === id) return { c, i, card };
  }
  return null;
}

// --- edits -----------------------------------------------------------------

// Every board action is one undo step holding the board before and after
// it. Undo sends that pair to the server as {base: after, board: before},
// which reverts this action alone against whatever the file holds now.
function commit(fn) {
  if (!S.base) return;
  const before = clone(S.board);
  fn(S.board.columns);
  if (same(before, S.board)) return;
  remember({ before, after: clone(S.board) });
  clampSel();
  schedule();
  render();
}

function remember(step) {
  S.undo.push(step);
  if (S.undo.length > 100) S.undo.shift();
}

// A modal field records its step when it is left: after is the board now,
// before is the same board with only that field set back, so undoing it
// never reverts what an agent wrote while you typed.
function fieldStep(id, field, old) {
  const before = clone(S.board);
  find(id, before).card[field] = old;
  remember({ before, after: clone(S.board) });
}

function undo() {
  const step = S.undo.pop();
  if (step) undoBoard(step);
}

async function undoBoard(step) {
  if (S.dirty || S.inflight) {
    // ponytail: poll until the pending save lands (it is already scheduled,
    // with its own backoff); a queue if undo grows more callers
    if ($('#problem').hidden) setTimeout(() => undoBoard(step), 50);
    else S.undo.push(step); // the file is unreadable: keep the step for later
    return;
  }
  S.inflight = true;
  status('saving');
  try {
    settle(await send(step.after, step.before));
  } catch (e) {
    S.inflight = false;
    S.undo.push(step);
    failed(e);
  }
}

function clampSel() {
  const cols = S.board.columns;
  S.sel.c = Math.max(0, Math.min(S.sel.c, cols.length - 1));
  S.sel.i = Math.max(-1, Math.min(S.sel.i, cols.length ? cols[S.sel.c].cards.length - 1 : -1));
}

export function addCard(c, i) {
  if (!S.board.columns.length) return;
  const id = S.ids.shift();
  refill();
  if (!id) return status('error', 'kban has not sent card ids yet; try again');
  S.sel = { c, i };
  startEdit({ c, i }, (cols) => cols[c].cards.splice(i, 0, { id, title: '' }));
}

export function addColumn(at) {
  S.sel = { c: at, i: -1 };
  startEdit({ c: at }, (cols) => cols.splice(at, 0, { title: '', cards: [] }));
}

export function remove(at) {
  if (at) S.sel = at;
  const { c, i } = S.sel;
  const cols = S.board.columns;
  if (!cols.length) return;
  if (i >= 0) commit((cols) => cols[c].cards.splice(i, 1));
  else if (!cols[c].cards.length) commit((cols) => cols.splice(c, 1));
}

function moveCard(from, to) {
  commit((cols) => {
    const [card] = cols[from.c].cards.splice(from.i, 1);
    cols[to.c].cards.splice(to.i, 0, card);
  });
  S.sel = { ...to };
  render();
}

function moveColumn(from, to) {
  commit((cols) => cols.splice(to, 0, ...cols.splice(from, 1)));
  S.sel = { c: to, i: -1 };
  render();
}

// Inline editing (a new card's title, a column title) writes straight into
// S.board from input events, so no render happens mid-edit. Esc and Enter
// both close; `u` is the way back.
export function startEdit(target, create) {
  if (!S.base) return;
  S.editSnap = clone(S.board);
  if (create) create(S.board.columns);
  S.edit = target;
  render();
}

function endEdit() {
  if (!S.edit) return;
  const { c, i } = S.edit;
  S.edit = null;
  const col = S.board.columns[c];
  if (i === undefined) {
    if (!col.title.trim()) {
      if (col.cards.length) col.title = 'Untitled';
      else S.board.columns.splice(c, 1);
    }
  } else if (!col.cards[i].title.trim()) {
    col.cards.splice(i, 1);
  }
  if (!same(S.board, S.editSnap)) remember({ before: S.editSnap, after: clone(S.board) });
  clampSel();
  schedule();
  render();
}

export function editKeys(e) {
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    endEdit();
  }
}

// Chrome fires focusout when a focused field is removed, so a re-render
// that starts an edit would immediately end it.
let rendering = false;
export function leaveEdit(e) {
  if (!rendering && !e.currentTarget.contains(e.relatedTarget)) endEdit();
}

// --- keyboard --------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (dialog.open) return cardKeys(e);
  if (!S.base || e.target.matches('input, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Enter' && e.target.matches('button')) return; // let a focused button click
  const cols = S.board.columns;
  const { c, i } = S.sel;
  const arrow = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j' }[e.key];
  const key = arrow ? (e.shiftKey ? arrow.toUpperCase() : arrow) : e.key;
  const handled = {
    h: () => { S.sel.c = c - 1; },
    l: () => { S.sel.c = c + 1; },
    k: () => { S.sel.i = i - 1; },
    j: () => { S.sel.i = i + 1; },
    H: () => i >= 0 && c > 0 && moveCard(S.sel, { c: c - 1, i: Math.min(i, cols[c - 1].cards.length) }),
    L: () => i >= 0 && c < cols.length - 1 && moveCard(S.sel, { c: c + 1, i: Math.min(i, cols[c + 1].cards.length) }),
    K: () => i > 0 && moveCard(S.sel, { c, i: i - 1 }),
    J: () => i >= 0 && i < cols[c].cards.length - 1 && moveCard(S.sel, { c, i: i + 1 }),
    Enter: () => cols.length && (i >= 0 ? openCard(c, i) : startEdit({ c })),
    n: () => addCard(c, i + 1),
    x: remove,
    Delete: remove,
    u: undo,
    '+': () => addColumn(Math.min(c + 1, cols.length)),
  }[key];
  if (!handled) return;
  e.preventDefault();
  handled();
  clampSel();
  render();
});

// --- drag and drop ---------------------------------------------------------

// The marker is the one node in #board that Preact does not own, so render()
// takes it out first; the next dragover puts it back.
const marker = document.createElement('div');

const board = $('#board');
board.addEventListener('dragstart', (e) => {
  const el = e.target.closest('.card, .col-head');
  if (!el) return;
  const c = +el.closest('.col').dataset.c;
  S.drag = el.classList.contains('card') ? { kind: 'card', from: { c, i: +el.dataset.i } } : { kind: 'col', from: c };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
  render();
});

board.addEventListener('dragover', (e) => {
  const col = e.target.closest('.col');
  const drag = S.drag;
  if (!drag || !col) return;
  e.preventDefault();
  const c = +col.dataset.c;
  if (drag.kind === 'col') {
    const after = e.clientX > col.getBoundingClientRect().left + col.offsetWidth / 2;
    marker.className = 'drop col-drop';
    col.insertAdjacentElement(after ? 'afterend' : 'beforebegin', marker);
    drag.to = c + (after ? 1 : 0);
    return;
  }
  const cards = [...col.querySelectorAll('.card')];
  const i = cards.filter((el) => e.clientY > el.getBoundingClientRect().top + el.offsetHeight / 2).length;
  marker.className = 'drop';
  if (i < cards.length) cards[i].before(marker);
  else col.querySelector('.cards').append(marker);
  drag.to = { c, i };
});

board.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!S.drag || S.drag.to === undefined) return;
  const { kind, from, to } = S.drag;
  S.drag = null;
  marker.remove();
  if (kind === 'col') {
    if (to !== from && to !== from + 1) moveColumn(from, to > from ? to - 1 : to);
  } else if (to.c === from.c) {
    const i = to.i > from.i ? to.i - 1 : to.i;
    if (i !== from.i) moveCard(from, { c: to.c, i });
  } else {
    moveCard(from, to);
  }
});

board.addEventListener('dragend', () => {
  S.drag = null;
  marker.remove();
  render();
});

// --- the card modal ----------------------------------------------------------

const dialog = $('#card');

export function openCard(c, i) {
  if (!S.base) return;
  leaveField();
  S.sel = { c, i };
  S.open = S.board.columns[c].cards[i].id;
  render();
  if (!dialog.open) dialog.showModal();
  grow($('#card-notes')); // a closed dialog measures nothing: size the fields once it shows
  grow($('#card-draft'));
  dialog.focus();
  dialog.querySelector('.card-main').scrollTop = 0;
}

// Blur the field being typed in first, so its edit commits to the card it
// was typed for, before the modal moves to another card or closes.
function leaveField() {
  const el = document.activeElement;
  if (dialog.contains(el) && el.matches('input, textarea')) {
    el.blur();
    dialog.focus();
  }
}

export function step(d) {
  const at = find(S.open);
  if (!at) return;
  const i = at.i + d;
  if (i >= 0 && i < S.board.columns[at.c].cards.length) openCard(at.c, i);
}

export function closeCard() {
  leaveField();
  dialog.close();
}

// close fires a task later, possibly after the next card was opened.
dialog.addEventListener('close', () => {
  if (dialog.open) return;
  const at = find(S.open);
  if (at) S.sel = { c: at.c, i: at.i };
  S.open = null;
  render();
});

dialog.addEventListener('cancel', (e) => {
  if (dialog.contains(document.activeElement) && document.activeElement.matches('input, textarea')) {
    e.preventDefault();
    leaveField();
  }
});

// A press on the backdrop targets the dialog itself.
dialog.addEventListener('pointerdown', (e) => { if (e.target === dialog) closeCard(); });

function cardKeys(e) {
  const typing = e.target.matches('input, textarea');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    step(e.key === 'ArrowUp' ? -1 : 1);
  } else if (mod && e.key === 'Enter' && e.target.id === 'card-draft') {
    e.preventDefault();
    post();
  } else if (typing && (e.key === 'Escape' || (e.key === 'Enter' && e.target.id === 'card-title'))) {
    e.preventDefault();
    leaveField();
  } else if (!typing && !mod && !e.altKey && e.key === 'c') {
    e.preventDefault();
    $('#card-draft').focus();
  } else if (!typing && !mod && !e.altKey && e.key === 'u') {
    e.preventDefault();
    undo();
  }
}

// The title commits on Enter or blur, not per keystroke, so one rename is
// one undo step.
let titleFrom = null;
export function titleFocus(e) { titleFrom = e.currentTarget.value; }
export function titleBlur(e) {
  const field = e.currentTarget;
  const from = titleFrom;
  titleFrom = null;
  const at = find(S.open);
  if (!at || field.value === from) return;
  if (!field.value.trim()) {
    field.value = at.card.title; // every card has a title: kban add and set refuse an empty one too
    return;
  }
  const old = at.card.title;
  at.card.title = field.value;
  fieldStep(S.open, 'title', old);
  schedule();
  render();
}

let notesFrom = null;
export function notesFocus(e) {
  grow(e.currentTarget); // it was last sized while hidden
  const at = find(S.open);
  notesFrom = at ? at.card.notes || '' : null;
}
export function notesInput(e) {
  grow(e.currentTarget);
  const at = find(S.open);
  if (!at) return;
  at.card.notes = e.currentTarget.value;
  schedule();
}
// A press below the notes blurs them on pointerdown. Showing the rendered
// view then would move what was pressed before the release and lose the
// click, so .held keeps the source shown until the click that follows the
// release. A drag or a touch scroll ends a press with pointercancel instead.
let pressing = false;
addEventListener('pointerdown', () => { pressing = true; }, true);
for (const end of ['pointerup', 'pointercancel']) addEventListener(end, () => { pressing = false; }, true);

// Render on leaving, so the rendered view shows the edit now, not when the
// save lands, which while the file is unreadable is never.
export function notesBlur(e) {
  if (pressing) {
    const box = e.currentTarget.parentNode;
    box.classList.add('held');
    const done = new AbortController();
    const release = () => { done.abort(); setTimeout(() => box.classList.remove('held')); };
    for (const end of ['pointerup', 'pointercancel']) addEventListener(end, release, { signal: done.signal });
  }
  const at = find(S.open);
  if (at && notesFrom !== null && (at.card.notes || '') !== notesFrom) fieldStep(S.open, 'notes', notesFrom);
  notesFrom = null;
  if (!rendering) render();
}

addEventListener('resize', () => { if (dialog.open) { grow($('#card-notes')); grow($('#card-draft')); } }); // text re-wraps

export function draftInput(e) {
  if (S.open) S.drafts[S.open] = e.currentTarget.value;
  grow(e.currentTarget);
  render(); // the post button follows the draft
}

export function post() {
  const draft = $('#card-draft');
  const text = draft.value.trim();
  const at = find(S.open);
  if (!text || !at) return;
  delete S.drafts[S.open];
  draft.value = ''; // before commit, whose render disables the post button; render leaves a focused field alone
  commit(() => {
    at.card.comments = [...(at.card.comments || []), { author: S.user, time: now(), text }];
  });
  grow(draft);
  draft.scrollIntoView({ block: 'nearest' });
}

export function deleteComment(j) {
  const at = find(S.open);
  if (at) commit(() => at.card.comments.splice(j, 1));
}

export function deleteOpenCard() {
  const at = find(S.open);
  if (!at) return;
  leaveField();
  S.open = null;
  dialog.close();
  remove({ c: at.c, i: at.i });
}

export function moveOpenCard(to) {
  leaveField();
  const at = find(S.open);
  if (!at || to === at.c) return;
  commit((cols) => cols[to].cards.push(...cols[at.c].cards.splice(at.i, 1)));
}

// Local time with its offset, the form `date -Iseconds` gives agents, so
// every comment's time reads the same in the file.
function now() {
  const d = new Date();
  const p = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off < 0 ? '-' : '+'}${p(off / 60)}:${p(off % 60)}`;
}

export function when(time) {
  const d = new Date(time);
  return isNaN(d) ? time : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// --- render ----------------------------------------------------------------

export function render() {
  rendering = true;
  marker.remove();
  note.readOnly = !S.base;
  if (document.activeElement !== note) {
    note.value = S.board.instructions || '';
    grow(note);
  }
  if (S.open && !find(S.open)) {
    S.open = null;
    dialog.close();
    status('saved', 'the open card was removed');
  }
  paint(h(Board), board);
  paint(h(CardBody), dialog);
  if (S.open) grow($('#card-notes'));
  rendering = false;
  const field = board.querySelector('input');
  if (field) {
    field.focus();
    if (S.edit.i === undefined) field.select(); // renaming: replace, not append
    else field.setSelectionRange(field.value.length, field.value.length);
  } else if (!dialog.open && !S.drag) { // scrolling mid-drag would move the board under the pointer
    board.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
