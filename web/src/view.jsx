import { Fragment } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { diagram } from './diagram.js';
import { md } from './md.js';
import {
  S, addCard, addColumn, addNew, addingColumn, closeCard, colKey, deleteComment, deleteOpenCard, discardNew, draftInput, editKeys, find, go, leaveEdit, moveOpenCard, newNotesInput, newTitleInput, notesBlur, notesFocus,
  notesInput, openCard, post, remove, sessionURL, startEdit, step, titleBlur, titleFocus, when,
} from './store.js';

const X = () => <svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7m0-7l-7 7" /></svg>;
const Plus = () => <svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" /></svg>;
const Speech = () => <svg viewBox="0 0 16 16"><path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z" /></svg>;
const Up = () => <svg viewBox="0 0 16 16"><path d="M4.5 10l3.5-3.5 3.5 3.5" /></svg>;
const Down = () => <svg viewBox="0 0 16 16"><path d="M4.5 6l3.5 3.5 3.5-3.5" /></svg>;

// Render never writes to a focused field: while focused it is uncontrolled,
// so an agent's edit landing as you type leaves your text and caret. The
// value key must always be passed; Preact skips an undefined value but
// would clear the field if the key were dropped.
export function Field({ tag: Tag = 'input', value, ...props }) {
  const ref = useRef();
  const focused = !!ref.current && ref.current === document.activeElement;
  return <Tag ref={ref} {...props} value={focused ? undefined : value} />;
}

// The only place file text and reports become markup. Preact sets the html
// again only when it changes, so a drawn diagram stays the same node through
// every render.
export function Md({ src, face, tag: Tag = 'div', ...props }) {
  const ref = useRef();
  const html = md(src, face);
  useEffect(() => {
    if (face) return;
    for (const code of ref.current.querySelectorAll('pre > code[class~=language-mermaid i]')) code.parentNode.replaceWith(diagram(code.textContent));
  }, [html, face]);
  return <Tag ref={ref} {...props} dangerouslySetInnerHTML={{ __html: html }} />;
}

const isEditing = (c) => S.edit?.c === c;

function DeleteButton({ at }) {
  return <button class="x" tabIndex={-1} title="Delete" onClick={(e) => { e.stopPropagation(); remove(at); }}><X /></button>;
}

function Card({ card, c, i }) {
  const sel = S.sel.c === c && S.sel.i === i;
  const dragging = S.drag?.kind === 'card' && S.drag.from.c === c && S.drag.from.i === i;
  const n = (card.comments || []).length;
  return (
    <article class={'card' + (sel ? ' sel' : '') + (dragging ? ' dragging' : '')} draggable tabIndex={-1} data-i={i} data-id={card.id}
      onClick={() => openCard(c, i)}>
      <div class="row"><span class="t">{card.title || 'Untitled'}</span><DeleteButton at={{ c, i }} /></div>
      {card.notes ? <Md class="b md" src={card.notes} face /> : null}
      {n ? <div class="meta" title={`${n} comment${n > 1 ? 's' : ''}`}><Speech />{n}</div> : null}
    </article>
  );
}

function Column({ col, c }) {
  const sel = S.sel.c === c && S.sel.i === -1;
  const dragging = S.drag?.kind === 'col' && S.drag.from === c;
  const head = isEditing(c)
    ? (
      <div class="col-head sel" onFocusOut={leaveEdit}>
        <Field placeholder="Column" value={col.title} onKeyDown={editKeys} onInput={(e) => { col.title = e.currentTarget.value; }} />
      </div>
    )
    : (
      <div class={'col-head' + (sel ? ' sel' : '') + (dragging ? ' dragging' : '')} draggable>
        <span class="t" title="Rename" onClick={() => { S.sel = { c, i: -1 }; startEdit({ c }); }}>{col.title || 'Untitled'}</span>
        <span class="n">{String(col.cards.length)}</span>
        {col.cards.length ? null : <DeleteButton at={{ c, i: -1 }} />}
      </div>
    );
  return (
    <section class="col" data-c={c}>
      {head}
      <div class="cards">{col.cards.map((card, i) => <Card key={card.id} card={card} c={c} i={i} />)}</div>
      <button class="add-card" onClick={() => addCard(c, col.cards.length)}><Plus />Add card</button>
    </section>
  );
}

export function Board() {
  return (
    <>
      {S.board.columns.map((col, c) => <Column key={colKey(c)} col={col} c={c} />)}
      {S.base ? <button class="add-col" onClick={() => addColumn(S.board.columns.length)}><Plus />Add column</button> : null}
    </>
  );
}

// The textarea stays mounted under the view, a label for it, so a click or a
// Tab edits the source natively; app.css swaps the two on focus.
function Notes({ notes }) {
  return (
    <div class="notes">
      <Field tag="textarea" id="card-notes" aria-label="Notes" rows={3} placeholder="Add notes" value={notes}
        onFocus={notesFocus} onInput={notesInput} onBlur={notesBlur} />
      {md(notes) ? <Md tag="label" for="card-notes" class="view md" src={notes} /> : null}
    </div>
  );
}

function NewCard() {
  const { title, notes } = S.newCard;
  const c = addingColumn();
  return (
    <>
      <header>
        <span id="card-where">{`New card · ${c < 0 ? 'its column was renamed or removed: close, and add it from another' : S.board.columns[c].title || 'Untitled'}`}</span>
        <button class="icon" id="card-close" title="Close, keeping the draft (Esc)" aria-label="Close" onClick={closeCard}><X /></button>
      </header>
      <div class="card-body new">
        <div class="card-main">
          <Field id="card-title" placeholder="Title" spellcheck={false} autocomplete="off" value={title} onInput={newTitleInput} />
          <div class="notes">
            <Field tag="textarea" id="card-notes" aria-label="Notes" rows={3} placeholder="Add notes" value={notes} onInput={newNotesInput} />
          </div>
          <div class="new-row">
            <span class="hint"><kbd>Ctrl</kbd> <kbd>⏎</kbd> to add · <kbd>Esc</kbd> keeps the draft</span>
            <button class="btn" id="card-discard" onClick={discardNew}>Discard</button>
            <button class="btn primary" id="card-add" disabled={!title.trim() || c < 0} onClick={addNew}>Add card</button>
          </div>
        </div>
      </div>
    </>
  );
}

export function CardBody() {
  if (S.adding) return <NewCard />;
  const at = S.open && find(S.open);
  if (!at) return null;
  const { c, i, card } = at;
  const col = S.board.columns[c];
  const comments = card.comments || [];
  const draft = S.drafts[S.open] || '';
  return (
    <>
      <header>
        <span id="card-where">{`${col.title || 'Untitled'} · ${i + 1} of ${col.cards.length}`}</span>
        <button class="icon" id="card-prev" title="Previous card (Ctrl+↑)" aria-label="Previous card" disabled={i === 0}
          onClick={() => step(-1)}><Up /></button>
        <button class="icon" id="card-next" title="Next card (Ctrl+↓)" aria-label="Next card" disabled={i === col.cards.length - 1}
          onClick={() => step(1)}><Down /></button>
        <button class="icon" id="card-close" title="Close (Esc)" aria-label="Close" onClick={closeCard}><X /></button>
      </header>
      <div class="card-body">
        <div class="card-main">
          <Field id="card-title" placeholder="Title" spellcheck={false} autocomplete="off" value={card.title}
            onFocus={titleFocus} onBlur={titleBlur} />
          <Notes notes={card.notes || ''} />
          <section class="thread" aria-label="Comments">
            <h3>Comments <span id="card-count">{comments.length || ''}</span></h3>
            <ol id="card-comments">
              {comments.length ? comments.map((cm, j) => (
                <li class="comment">
                  <Tile of={cm.author} />
                  <div class="comment-body">
                    <div class="comment-head">
                      <span class="who">{cm.author || 'unknown'}</span>
                      <time dateTime={cm.time} title={cm.time}>{when(cm.time)}</time>
                      <button class="x" title="Delete comment" aria-label="Delete comment" onClick={() => deleteComment(j)}><X /></button>
                    </div>
                    <Md class="comment-text md" src={cm.text} />
                  </div>
                </li>
              )) : <li class="empty">No comments yet. Agents report here; you can reply.</li>}
            </ol>
            <div class="composer">
              <Field tag="textarea" id="card-draft" rows={2} placeholder="Write a comment" value={draft} onInput={draftInput} />
              <div class="composer-row">
                <span class="hint"><kbd>Ctrl</kbd> <kbd>⏎</kbd> to post · <kbd>c</kbd> to write · <kbd>Ctrl</kbd> <kbd>↑↓</kbd> next card</span>
                <button class="btn primary" id="card-post" disabled={!draft.trim()} onClick={post}>Comment</button>
              </div>
            </div>
          </section>
        </div>
        <aside class="card-side">
          <h3>Column</h3>
          <div id="card-cols">
            {S.board.columns.map((cl, j) => (
              <button class="pick" aria-pressed={String(j === c)} onClick={() => moveOpenCard(j)}>{cl.title || 'Untitled'}</button>
            ))}
          </div>
          {card.meta ? (
            <>
              <h3 class="kv-head">Meta</h3>
              <dl class="kv" id="card-kv">
                {Object.entries(card.meta).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
              </dl>
            </>
          ) : null}
          <button class="btn danger" id="card-delete" onClick={deleteOpenCard}>Delete card</button>
        </aside>
      </div>
    </>
  );
}

// A link that waits for this tab's unsaved edits before it leaves.
function Link({ href, current, children, ...props }) {
  return (
    <a href={href} aria-current={current ? 'page' : undefined} {...props} onClick={(e) => {
      if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // a new tab or window: the browser's own
      e.preventDefault();
      go(href);
    }}>{children}</a>
  );
}

// data-tip is the rail's tooltip, so the rows carry no title: a native one
// would show beside it.
const Tile = ({ of }) => <span class="tile" aria-hidden="true">{([...(of || '').trim()][0] || '?').toUpperCase()}</span>;
const Badge = ({ n }) => n ? <span class="badge" role="img" aria-label={`${n} question${n > 1 ? 's' : ''} waiting`}>{n > 1 ? `?${n}` : '?'}</span> : null;
const Dot = ({ on, label }) => on ? <span class="dot" role="img" aria-label={label} /> : null;

// A project row stands for every question waiting in it: data-tokens is
// what the hub is told this tab showed.
export function Sidebar({ projects, here }) {
  return projects.map((p) => (
    <Link class="item tip" href={p.href} current={p.name === here} data-project={p.name} data-tokens={p.tokens.join(' ')} data-tip={p.name}>
      <Tile of={p.name} />
      <span class="label">{p.name}</span>
      <Badge n={p.tokens.length} />
      <Dot on={p.unread} label="changed" />
    </Link>
  ));
}

export function Tabs({ p, shown, session }) {
  return (
    <>
      {p.boards.map((b) => (
        <Link class="tab" href={`/b/${b.id}`} current={b.id === shown} data-id={b.id}>
          <span class="file">{b.file}</span><Dot on={b.changed} label="changed" />
        </Link>
      ))}
      {p.sessions.length ? (
        <Link class="tab" href={sessionURL(p.sessions[0].session)} current={session !== null} data-tab="sessions">
          Sessions<Badge n={p.tokens.length} /><Dot on={p.sessions.some((s) => s.unread)} label="new report" />
        </Link>
      ) : null}
    </>
  );
}

const clock = (t) => (new Date(t).toDateString() === new Date().toDateString()
  ? new Date(t).toLocaleTimeString(undefined, { timeStyle: 'short' }) : when(t));

// Agent text, so JSX text only.
export function Sessions({ p, session }) {
  return p.sessions.map((s) => (
    <Link class="item" href={sessionURL(s.session)} current={s.session === session} data-session={s.session}>
      <span class="two">
        <span class="label">{s.task || s.line || s.session}</span>
        <small>{[s.time ? clock(s.time) : '', s.branch].filter(Boolean).join(' · ')}</small>
      </span>
      <Badge n={s.waiting} />
      <Dot on={s.unread} label="new report" />
    </Link>
  ));
}

export function Reports({ reports }) {
  if (!reports.length) return null;
  return (
    <section class="reports" aria-label="Reports">
      <h3>Reports</h3>
      {reports.map((r) => (
        <article key={r.time} data-time={r.time}>
          <time dateTime={new Date(r.time).toISOString()}>{when(r.time)}</time>
          <Md class="prose md" src={r.text} />
        </article>
      ))}
    </section>
  );
}
