import { useRef } from 'preact/hooks';
import { md } from './md.js';
import {
  S, addCard, addColumn, closeCard, deleteComment, deleteOpenCard, draftInput, draftKey, editKeys, find, keyAt,
  leaveEdit, moveOpenCard, notesBlur, notesFocus, notesInput, openCard, post, remove, startEdit, step, titleBlur,
  titleFocus, when,
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
function Field({ tag: Tag = 'input', value, ...props }) {
  const ref = useRef();
  const focused = !!ref.current && ref.current === document.activeElement;
  return <Tag ref={ref} {...props} value={focused ? undefined : value} />;
}

// The only place file text becomes markup.
const Md = ({ src, face, ...props }) => <div {...props} dangerouslySetInnerHTML={{ __html: md(src, face) }} />;

const isEditing = (c, i) => S.edit && S.edit.c === c && S.edit.i === i;

function DeleteButton({ at }) {
  return <button class="x" tabIndex={-1} title="Delete" onClick={(e) => { e.stopPropagation(); remove(at); }}><X /></button>;
}

function Card({ card, c, i }) {
  if (isEditing(c, i)) {
    return (
      <article class="card edit sel" onFocusOut={leaveEdit}>
        <Field placeholder="Title, then Enter" value={card.title} onKeyDown={editKeys}
          onInput={(e) => { card.title = e.currentTarget.value; }} />
      </article>
    );
  }
  const sel = S.sel.c === c && S.sel.i === i;
  const dragging = S.drag?.kind === 'card' && S.drag.from.c === c && S.drag.from.i === i;
  const n = (card.comments || []).length;
  return (
    <article class={'card' + (sel ? ' sel' : '') + (dragging ? ' dragging' : '')} draggable tabIndex={-1} data-i={i}
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
  const head = isEditing(c, undefined)
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
      <div class="cards">{col.cards.map((card, i) => <Card key={draftKey(keyAt(c, i))} card={card} c={c} i={i} />)}</div>
      <button class="add-card" onClick={() => addCard(c, col.cards.length)}><Plus />Add card</button>
    </section>
  );
}

function colKey(c) {
  const title = S.board.columns[c].title;
  return draftKey({ title, n: S.board.columns.slice(0, c).filter((col) => col.title === title).length });
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
  const html = md(notes);
  return (
    <div class="notes">
      <Field tag="textarea" id="card-notes" aria-label="Notes" rows={3} placeholder="Add notes" value={notes}
        onFocus={notesFocus} onInput={notesInput} onBlur={notesBlur} />
      {html ? <label for="card-notes" class="view md" dangerouslySetInnerHTML={{ __html: html }} /> : null}
    </div>
  );
}

export function CardBody() {
  const at = S.open && find(S.open);
  if (!at) return null;
  const { c, i, card } = at;
  const col = S.board.columns[c];
  const comments = card.comments || [];
  const draft = S.drafts[draftKey(S.open)] || '';
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
                  <span class="tile" aria-hidden="true">{(cm.author || '?').slice(0, 1).toUpperCase()}</span>
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
          <button class="btn danger" id="card-delete" onClick={deleteOpenCard}>Delete card</button>
        </aside>
      </div>
    </>
  );
}
