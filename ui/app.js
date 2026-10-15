'use strict';

const $ = (s) => document.querySelector(s);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// base is the board the server last acknowledged; local edits are relative
// to it. The server merges {base, board} against the file, so this client
// never merges anything itself.
const S = {
  board: { columns: [] },
  base: null,             // null until the first board: an edit saved against no base replaces every column
  user: '',               // author of comments posted here
  file: '',
  sel: { c: 0, i: -1 },   // i === -1 selects the column header
  edit: null,             // { c, i } for a new card's title, { c } for a column title
  editSnap: null,
  undo: [],               // { before, after } board steps, or { key, field, old } modal field steps
  dirty: false,
  inflight: false,
  timer: 0,
  open: null,             // key of the card in the modal: { title, n }
  drafts: {},             // unsent comment per card key
};

// --- server ----------------------------------------------------------------

async function load() {
  const { file, user, board, error } = await (await fetch('/api/board')).json();
  S.file = file;
  S.user = user;
  $('#file').textContent = file;
  document.title = file;
  receive({ board, error });
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

function listen() {
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

// --- cards by key ------------------------------------------------------------

// A card is known by its title and which repeat of that title it is, the
// same identity the server merges by, so the modal follows its card while
// the board changes underneath it.
function keyAt(c, i) {
  const title = S.board.columns[c].cards[i].title;
  let n = 0;
  for (let cc = 0; cc <= c; cc++) {
    const cards = S.board.columns[cc].cards;
    for (let ii = 0; ii < (cc === c ? i : cards.length); ii++) if (cards[ii].title === title) n++;
  }
  return { title, n };
}

function find(key) {
  if (!key) return null;
  let n = 0;
  for (const [c, col] of S.board.columns.entries()) {
    for (const [i, card] of col.cards.entries()) {
      if (card.title === key.title && n++ === key.n) return { c, i, card };
    }
  }
  return null;
}

const sameKey = (a, b) => !!a && !!b && a.title === b.title && a.n === b.n;
const draftKey = (k) => `${k.n}\u0000${k.title}`;

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

function undo() {
  const step = S.undo.pop();
  if (!step) return;
  if (step.field) undoField(step);
  else undoBoard(step);
}

// A modal field is undone as an ordinary edit of the board as it is now.
// Sent as {after, before}, a title revert would be a delete plus an add and
// drop whatever the card gained since.
function undoField(step) {
  const at = find(step.key);
  if (!at) return status('error', 'that card is gone; nothing undone');
  at.card[step.field] = step.old;
  if (sameKey(S.open, step.key)) S.open = keyAt(at.c, at.i);
  schedule();
  render();
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

function addCard(c, i) {
  if (!S.board.columns.length) return;
  S.sel = { c, i };
  startEdit({ c, i }, (cols) => cols[c].cards.splice(i, 0, { title: '' }));
}

function addColumn(at) {
  S.sel = { c: at, i: -1 };
  startEdit({ c: at }, (cols) => cols.splice(at, 0, { title: '', cards: [] }));
}

function remove(at) {
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
function startEdit(target, create) {
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

let drag = null; // { kind: 'card', from: {c, i}, to } | { kind: 'col', from: c, to }
const marker = document.createElement('div');

const board = $('#board');
board.addEventListener('dragstart', (e) => {
  const el = e.target.closest('.card, .col-head');
  if (!el) return;
  const c = +el.closest('.col').dataset.c;
  drag = el.classList.contains('card') ? { kind: 'card', from: { c, i: +el.dataset.i } } : { kind: 'col', from: c };
  el.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
});

board.addEventListener('dragover', (e) => {
  const col = e.target.closest('.col');
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
  if (!drag || drag.to === undefined) return;
  const { kind, from, to } = drag;
  drag = null;
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
  drag = null;
  marker.remove();
  render();
});

// --- the card modal ----------------------------------------------------------

// The title commits on Enter or blur, not per keystroke: every rename that
// reaches the file drops what an agent added to the card meanwhile.
const dialog = $('#card');
const titleField = $('#card-title');
const notesField = $('#card-notes');
const draft = $('#card-draft');
const postButton = $('#card-post');

function openCard(c, i) {
  if (!S.base) return;
  leaveField();
  S.sel = { c, i };
  S.open = keyAt(c, i);
  draft.value = S.drafts[draftKey(S.open)] || '';
  postButton.disabled = !draft.value.trim();
  render();
  if (!dialog.open) dialog.showModal();
  grow(notesField); // a closed dialog measures nothing: size the fields once it shows
  grow(draft);
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

function step(d) {
  const at = find(S.open);
  if (!at) return;
  const i = at.i + d;
  if (i >= 0 && i < S.board.columns[at.c].cards.length) openCard(at.c, i);
}

function closeCard() {
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
  } else if (mod && e.key === 'Enter' && e.target === draft) {
    e.preventDefault();
    post();
  } else if (typing && (e.key === 'Escape' || (e.key === 'Enter' && e.target === titleField))) {
    e.preventDefault();
    leaveField();
  } else if (!typing && !mod && !e.altKey && e.key === 'c') {
    e.preventDefault();
    draft.focus();
  } else if (!typing && !mod && !e.altKey && e.key === 'u') {
    e.preventDefault();
    undo();
  }
}

$('#card-prev').addEventListener('click', () => step(-1));
$('#card-next').addEventListener('click', () => step(1));
$('#card-close').addEventListener('click', closeCard);

let titleFrom = null;
titleField.addEventListener('focus', () => { titleFrom = titleField.value; });
titleField.addEventListener('blur', () => {
  const from = titleFrom;
  titleFrom = null;
  const at = find(S.open);
  if (!at || titleField.value === from) return;
  if (!titleField.value.trim()) {
    titleField.value = at.card.title; // agents and the merge cannot tell untitled cards apart
    return;
  }
  const old = at.card.title;
  const oldDraft = draftKey(S.open);
  at.card.title = titleField.value;
  S.open = keyAt(at.c, at.i);
  if (S.drafts[oldDraft] !== undefined) {
    S.drafts[draftKey(S.open)] = S.drafts[oldDraft];
    delete S.drafts[oldDraft];
  }
  remember({ key: S.open, field: 'title', old });
  schedule();
  render();
});

let notesFrom = null;
notesField.addEventListener('focus', () => {
  const at = find(S.open);
  notesFrom = at ? at.card.notes || '' : null;
});
notesField.addEventListener('input', () => {
  grow(notesField);
  const at = find(S.open);
  if (!at) return;
  at.card.notes = notesField.value;
  schedule();
});
notesField.addEventListener('blur', () => {
  const at = find(S.open);
  if (at && notesFrom !== null && (at.card.notes || '') !== notesFrom) {
    remember({ key: S.open, field: 'notes', old: notesFrom });
  }
  notesFrom = null;
});

addEventListener('resize', () => { if (dialog.open) { grow(notesField); grow(draft); } }); // text re-wraps

draft.addEventListener('input', () => {
  if (S.open) S.drafts[draftKey(S.open)] = draft.value;
  postButton.disabled = !draft.value.trim();
  grow(draft);
});
postButton.addEventListener('click', post);

function post() {
  const text = draft.value.trim();
  const at = find(S.open);
  if (!text || !at) return;
  commit(() => {
    at.card.comments = [...(at.card.comments || []), { author: S.user, time: now(), text }];
  });
  delete S.drafts[draftKey(S.open)];
  draft.value = '';
  postButton.disabled = true;
  grow(draft);
  draft.scrollIntoView({ block: 'nearest' });
}

function deleteComment(j) {
  const at = find(S.open);
  if (at) commit(() => at.card.comments.splice(j, 1));
}

$('#card-delete').addEventListener('click', () => {
  const at = find(S.open);
  if (!at) return;
  leaveField();
  S.open = null;
  dialog.close();
  remove({ c: at.c, i: at.i });
});

function moveOpenCard(to) {
  leaveField();
  const at = find(S.open);
  if (!at || to === at.c) return;
  commit((cols) => {
    cols[to].cards.push(...cols[at.c].cards.splice(at.i, 1));
    S.open = keyAt(to, cols[to].cards.length - 1); // before commit renders: a same-titled card may take the old key
  });
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

function when(time) {
  const d = new Date(time);
  return isNaN(d) ? time : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderCard() {
  if (!S.open) return;
  const at = find(S.open);
  if (!at) {
    S.open = null;
    dialog.close();
    status('saved', 'the open card was renamed or removed');
    return;
  }
  const { c, i, card } = at;
  const col = S.board.columns[c];
  $('#card-where').textContent = `${col.title || 'Untitled'} · ${i + 1} of ${col.cards.length}`;
  $('#card-prev').disabled = i === 0;
  $('#card-next').disabled = i === col.cards.length - 1;
  if (document.activeElement !== titleField) titleField.value = card.title;
  if (document.activeElement !== notesField) notesField.value = card.notes || '';
  grow(notesField);

  const comments = card.comments || [];
  $('#card-count').textContent = comments.length || '';
  $('#card-comments').replaceChildren(...(comments.length ? comments.map((cm, j) =>
    h('li', { class: 'comment' },
      h('span', { class: 'tile', ariaHidden: 'true' }, (cm.author || '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'comment-body' },
        h('div', { class: 'comment-head' },
          h('span', { class: 'who' }, cm.author || 'unknown'),
          h('time', { dateTime: cm.time, title: cm.time }, when(cm.time)),
          h('button', { class: 'x', title: 'Delete comment', ariaLabel: 'Delete comment', innerHTML: icons.x,
            onclick: () => deleteComment(j) })),
        h('div', { class: 'comment-text' }, cm.text))))
    : [h('li', { class: 'empty' }, 'No comments yet. Agents report here; you can reply.')]));

  $('#card-cols').replaceChildren(...S.board.columns.map((cl, j) =>
    h('button', { class: 'pick', ariaPressed: String(j === c), onclick: () => moveOpenCard(j) }, cl.title || 'Untitled')));
}

// --- render ----------------------------------------------------------------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'data') Object.assign(el.dataset, v);
    else el[k] = v;
  }
  el.append(...kids.filter((k) => k != null));
  return el;
}

function editKeys(e) {
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    endEdit();
  }
}

// Chrome fires focusout when a focused field is removed, so a re-render
// that starts an edit would immediately end it.
let rendering = false;
function leaveEdit(e) {
  if (!rendering && !e.currentTarget.contains(e.relatedTarget)) endEdit();
}

const icons = {
  x: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7m0-7l-7 7"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  comment: '<svg viewBox="0 0 16 16"><path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z"/></svg>',
};

function deleteButton(at) {
  return h('button', { class: 'x', tabIndex: -1, title: 'Delete', innerHTML: icons.x,
    onclick: (e) => { e.stopPropagation(); remove(at); } });
}

function isEditing(c, i) {
  return S.edit && S.edit.c === c && S.edit.i === i;
}

function cardEl(card, c, i) {
  if (isEditing(c, i)) {
    return h('article', { class: 'card edit sel', onfocusout: leaveEdit },
      h('input', { value: card.title, placeholder: 'Title, then Enter', onkeydown: editKeys,
        oninput: (e) => { card.title = e.target.value; } }));
  }
  const sel = S.sel.c === c && S.sel.i === i;
  const n = (card.comments || []).length;
  return h('article', { class: sel ? 'card sel' : 'card', draggable: true, tabIndex: -1, data: { i },
    onclick: () => openCard(c, i) },
    h('div', { class: 'row' }, h('span', { class: 't' }, card.title || 'Untitled'), deleteButton({ c, i })),
    card.notes ? h('div', { class: 'b' }, card.notes) : null,
    n ? h('div', { class: 'meta', title: `${n} comment${n > 1 ? 's' : ''}`, innerHTML: icons.comment + n }) : null);
}

function columnEl(col, c) {
  const sel = S.sel.c === c && S.sel.i === -1;
  const head = isEditing(c, undefined)
    ? h('div', { class: 'col-head sel', onfocusout: leaveEdit },
        h('input', { value: col.title, placeholder: 'Column', onkeydown: editKeys,
          oninput: (e) => { col.title = e.target.value; } }))
    : h('div', { class: sel ? 'col-head sel' : 'col-head', draggable: true },
        h('span', { class: 't', title: 'Rename', onclick: () => { S.sel = { c, i: -1 }; startEdit({ c }); } }, col.title || 'Untitled'),
        h('span', { class: 'n' }, String(col.cards.length)),
        col.cards.length ? null : deleteButton({ c, i: -1 }));
  return h('section', { class: 'col', data: { c } }, head,
    h('div', { class: 'cards' }, ...col.cards.map((card, i) => cardEl(card, c, i))),
    h('button', { class: 'add-card', innerHTML: icons.plus + 'Add card', onclick: () => addCard(c, col.cards.length) }));
}

function render() {
  rendering = true;
  note.readOnly = !S.base;
  if (document.activeElement !== note) {
    note.value = S.board.instructions || '';
    grow(note);
  }
  board.replaceChildren(
    ...S.board.columns.map(columnEl),
    S.base ? h('button', { class: 'add-col', innerHTML: icons.plus + 'Add column', onclick: () => addColumn(S.board.columns.length) }) : null);
  renderCard();
  rendering = false;
  const field = board.querySelector('input');
  if (field) {
    field.focus();
    if (S.edit.i === undefined) field.select(); // renaming: replace, not append
    else field.setSelectionRange(field.value.length, field.value.length);
  } else if (!dialog.open) {
    board.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

load().then(listen);
