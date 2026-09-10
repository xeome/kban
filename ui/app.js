'use strict';

const $ = (s) => document.querySelector(s);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// base is the board the server last acknowledged; local edits are relative
// to it. The server merges {base, board} against the file, so this client
// never merges anything itself.
const S = {
  board: { columns: [] },
  base: null,
  sel: { c: 0, i: -1 },   // i === -1 selects the column header
  edit: null,             // { c, i } for a card, { c } for a column title
  undo: [],
  dirty: false,
  inflight: false,
  timer: 0,
};

// --- server ----------------------------------------------------------------

async function load() {
  const { file, board } = await (await fetch('/api/board')).json();
  $('#file').textContent = file;
  document.title = file;
  adopt(board);
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

async function save() {
  if (S.inflight) return;
  S.inflight = true;
  S.dirty = false;
  const prevBase = S.base;
  const body = JSON.stringify({ base: S.base, board: S.board });
  S.base = clone(S.board);
  status('saving');
  try {
    const r = await fetch('/api/board', { method: 'PUT', body });
    if (!r.ok) throw new Error(await r.text());
    const merged = await r.json();
    S.inflight = false;
    status('saved');
    if (S.dirty) save();
    else adopt(merged);
  } catch (e) {
    S.inflight = false;
    S.base = prevBase;
    S.dirty = true;
    status('error', 'save failed: ' + e.message);
    S.timer = setTimeout(save, 2000);
  }
}

function listen() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => adopt(JSON.parse(e.data));
  es.onopen = () => { status('saved'); load(); };
  es.onerror = () => status('offline');
}

function status(state, text) {
  const el = $('#status');
  el.dataset.state = state;
  el.textContent = text || { saving: 'saving…', saved: 'saved', offline: 'offline' }[state];
}

// --- edits -----------------------------------------------------------------

function commit(fn) {
  S.undo.push(clone(S.board));
  if (S.undo.length > 100) S.undo.shift();
  fn(S.board.columns);
  clampSel();
  schedule();
  render();
}

function undo() {
  if (!S.undo.length) return;
  S.board = S.undo.pop();
  clampSel();
  schedule();
  render();
}

function clampSel() {
  const cols = S.board.columns;
  S.sel.c = Math.max(0, Math.min(S.sel.c, cols.length - 1));
  S.sel.i = Math.max(-1, Math.min(S.sel.i, cols.length ? cols[S.sel.c].cards.length - 1 : -1));
}

function addCard(c, i) {
  if (!S.board.columns.length) return;
  S.sel = { c, i };
  startEdit({ c, i }, (cols) => cols[c].cards.splice(i, 0, { title: '', body: '' }));
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

// Editing writes straight into S.board from input events, so no render
// happens mid-edit. Esc and Enter both close; `u` is the way back.
function startEdit(target, create) {
  S.undo.push(clone(S.board));
  if (create) create(S.board.columns);
  S.edit = target;
  render();
}

function endEdit() {
  if (!S.edit) return;
  const { c, i } = S.edit;
  S.edit = null;
  const snap = S.undo.pop();
  const col = S.board.columns[c];
  if (i === undefined) {
    if (!col.title.trim()) {
      if (col.cards.length) col.title = 'Untitled';
      else S.board.columns.splice(c, 1);
    }
  } else if (!col.cards[i].title.trim()) {
    col.cards.splice(i, 1);
  }
  if (!same(S.board, snap)) S.undo.push(snap);
  clampSel();
  schedule();
  render();
}

// --- keyboard --------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
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
    Enter: () => cols.length && startEdit(i >= 0 ? { c, i } : { c }),
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
  if (e.key === 'Escape') endEdit();
  else if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey)) {
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

function deleteButton(at) {
  return h('button', { class: 'x', tabIndex: -1, title: 'Delete',
    onclick: (e) => { e.stopPropagation(); remove(at); } }, '×');
}

function isEditing(c, i) {
  return S.edit && S.edit.c === c && S.edit.i === i;
}

function cardEl(card, c, i) {
  const sel = S.sel.c === c && S.sel.i === i;
  if (isEditing(c, i)) {
    const rows = () => Math.max(2, card.body.split('\n').length + 1);
    return h('article', { class: 'card edit sel', onfocusout: leaveEdit },
      h('input', { value: card.title, placeholder: 'Title', onkeydown: editKeys,
        oninput: (e) => { card.title = e.target.value; schedule(); } }),
      h('textarea', { value: card.body, placeholder: 'Notes', rows: rows(), onkeydown: editKeys,
        oninput: (e) => { card.body = e.target.value; e.target.rows = rows(); schedule(); } }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: endEdit }, 'Done'),
        h('button', { class: 'btn danger', onclick: () => { S.edit = null; S.undo.pop(); remove({ c, i }); } }, 'Delete'),
        h('span', { class: 'hint' }, 'Esc closes')));
  }
  return h('article', { class: sel ? 'card sel' : 'card', draggable: true, tabIndex: -1, data: { i },
    onclick: () => { S.sel = { c, i }; startEdit({ c, i }); } },
    h('div', { class: 'row' }, h('span', { class: 't' }, card.title || 'Untitled'), deleteButton({ c, i })),
    card.body ? h('div', { class: 'b' }, card.body) : null);
}

function columnEl(col, c) {
  const sel = S.sel.c === c && S.sel.i === -1;
  const head = isEditing(c, undefined)
    ? h('div', { class: 'col-head sel', onfocusout: leaveEdit },
        h('input', { value: col.title, placeholder: 'Column', onkeydown: editKeys,
          oninput: (e) => { col.title = e.target.value; schedule(); } }))
    : h('div', { class: sel ? 'col-head sel' : 'col-head', draggable: true },
        h('span', { class: 't', title: 'Rename', onclick: () => { S.sel = { c, i: -1 }; startEdit({ c }); } }, col.title || 'Untitled'),
        h('span', { class: 'n' }, String(col.cards.length)),
        col.cards.length ? null : deleteButton({ c, i: -1 }));
  return h('section', { class: 'col', data: { c } }, head,
    h('div', { class: 'cards' }, ...col.cards.map((card, i) => cardEl(card, c, i))),
    h('button', { class: 'add-card', onclick: () => addCard(c, col.cards.length) }, '+ Add card'));
}

function render() {
  rendering = true;
  board.replaceChildren(
    ...S.board.columns.map(columnEl),
    h('button', { class: 'add-col', onclick: () => addColumn(S.board.columns.length) }, '+ Add column'));
  rendering = false;
  const field = board.querySelector('input');
  if (field) {
    field.focus();
    if (S.edit.i === undefined) field.select(); // renaming: replace, not append
    else field.setSelectionRange(field.value.length, field.value.length);
  } else {
    board.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

load().then(listen);
