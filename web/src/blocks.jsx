import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { diagram } from './diagram.js';
import { md, mdInline } from './md.js';
import { Field, Reports } from './view.jsx';

// A question is an agent's text: every string reaches markup only
// through md() (text blocks) or mdInline() (one-line fields and cells).
// Code and diffs are JSX text.
export const Inline = ({ src, tag: Tag = 'span', ...props }) => <Tag {...props} dangerouslySetInnerHTML={{ __html: mdInline(src) }} />;

const L = 'ABCD';
const WIDE = new Set(['code', 'diff', 'table', 'diagram', 'image']);
const NUM = /^[-+−~≈]?\s*[\d.,]+\s*(%|ms|s|px|kb|mb|gb|x|°|k|m)?$/i;
const lines = (s) => s.replace(/\n$/, '').split('\n');

function Diagram({ src }) {
  const ref = useRef();
  useEffect(() => { ref.current.replaceChildren(diagram(src)); }, [src]);
  return <div ref={ref} />;
}

function Diff({ src }) {
  let inHunk = false;
  return (
    <div class="scroll"><pre class="diff">{lines(src).map((l) => {
      if (l.startsWith('@@')) inHunk = true;
      const c = l.startsWith('@@') ? 'hunk' : !inHunk && /^(\+\+\+|---|diff |index )/.test(l) ? 'meta'
        : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';
      const body = c === 'add' || c === 'del' ? l.slice(1) : c === '' ? l.replace(/^ /, '') : l;
      return <span class={`l ${c}`}><span class="s">{c === 'add' ? '+' : c === 'del' ? '−' : ''}</span>{body}</span>;
    })}</pre></div>
  );
}

function Table({ b }) {
  const num = b.columns.map((_, j) => b.rows.every((r) => !r[j].trim() || NUM.test(r[j].trim())));
  return (
    <div class="scroll">
      <table class="t">
        <thead><tr>{b.columns.map((c, j) => <Inline tag="th" class={num[j] ? 'num' : ''} src={c} />)}</tr></thead>
        <tbody>{b.rows.map((r) => <tr>{r.map((c, j) => <Inline tag="td" class={num[j] ? 'num' : ''} src={c} />)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Body({ b, path, token }) {
  switch (b.kind) {
    case 'text': return <div class="prose md" dangerouslySetInnerHTML={{ __html: md(b.text) }} />;
    case 'code': return <div class="scroll"><pre class="code">{lines(b.code).map((l) => <span class="l">{l}</span>)}</pre></div>;
    case 'diff': return <Diff src={b.diff} />;
    case 'table': return <Table b={b} />;
    case 'stats': return (
      <div class="stats">{b.items.map((it) => (
        <div class="stat"><Inline class="v" tag="div" src={it.value} /><Inline class="lb" tag="div" src={it.label} />
          {it.note ? <Inline class="nt" tag="div" src={it.note} /> : null}</div>
      ))}</div>
    );
    case 'diagram': return <Diagram src={b.mermaid} />;
    case 'image': {
      const src = `/api/q/${token}/file/${encodeURIComponent(path)}`;
      return <a href={src} target="_blank" rel="noopener" title="Open full size"><img src={src} alt={b.title || 'image'} /></a>;
    }
  }
  return null;
}

// path names the block as the question does, e.g. rows[1].cells[2]: the image route finds a file by it.
export function Block({ b, path, framed, token }) {
  const lang = b.kind === 'code' && b.lang;
  return (
    <figure class={`blk k-${b.kind}${framed ? ' frame' : ''}`} data-kind={b.kind} data-path={path}>
      {b.title || lang ? <figcaption>{b.title ? <Inline src={b.title} /> : null}{lang ? <span class="lang">{lang}</span> : null}</figcaption> : null}
      <Body b={b} path={path} token={token} />
    </figure>
  );
}

const words = {};          // what is typed in each question's box, by token
const sent = new Set();    // tokens this page's own Send got a 200 for
const sending = new Set(); // tokens with a Send still out: kept on screen until it lands
let shown = [];            // [{token, id}] the page last showed
let unsent = [];           // [{id, words}] typed here for a question that closed unanswered by this page
let last = null;
let root = null;

// A question that stops being open keeps the words typed for it, unless
// this page's own Send got a 200; that 200 also clears the words kept so far.
export function showSession(s, el) {
  last = s;
  root = el;
  const open = new Set(s.questions.map((q) => q.token));
  for (const q of shown) {
    if (!open.has(q.token) && !sending.has(q.token) && !sent.has(q.token) && (words[q.token] || '').trim()) unsent.push({ id: q.id, words: words[q.token] });
  }
  shown = [...s.questions.map((q) => ({ token: q.token, id: q.question.id })), ...shown.filter((q) => sending.has(q.token) && !open.has(q.token))];
  render(<Session s={s} />, el);
}
const repaint = () => last && showSession(last, root);

function Session({ s }) {
  return (
    <>
      {s.source ? (
        <div class="who">
          {s.source.task ? <h2>{s.source.task}</h2> : null}
          <div class="sub" title={s.source.path}>{[s.source.project, s.source.branch].filter(Boolean).join(' · ')}</div>
        </div>
      ) : null}
      {unsent.length ? <div class="unsents">{unsent.map((u) => <Unsent {...u} />)}</div> : null}
      <div class="qs">{s.questions.map((q) => <Question key={q.token} token={q.token} q={q.question} lean={leanOf(s.sitting, q)} />)}</div>
      {s.questions.length ? null : <Waiting sitting={s.sitting} />}
      {s.sitting.length ? (
        <section class="sitting" aria-label="Sitting">
          <h3>Sitting</h3>
          <ol>{s.sitting.map((e) => (
            <li class="sit" data-id={e.id} data-status={e.status}>
              <span class="glyph">{glyph(e)}</span>
              <div class="txt"><div class="id">{e.id}</div><div class="qq">{e.question}</div><div class="ans">{answerLine(e)}</div></div>
            </li>
          ))}</ol>
        </section>
      ) : null}
      <Reports reports={s.reports} />
    </>
  );
}

// A re-ask after an Ask that leaned to an option: the option with that
// label, since the options may have moved. Only the asking relay's own last
// answer counts, so a question another relay of the session asks under the
// same id never inherits it.
function leanOf(sitting, { relay, question: q }) {
  const mine = sitting.filter((e) => e.relay === relay);
  const prev = mine[mine.findIndex((e) => e.status === 'open') - 1];
  return prev?.id === q.id && prev.answer?.kind === 'ask' && prev.answer.label !== null
    ? q.options.findIndex((o) => o.label === prev.answer.label) : -1;
}

function glyph(e) {
  if (e.status === 'open') return <span class="dot" />;
  if (e.status === 'cancelled') return <span class="tile">–</span>;
  const a = e.answer;
  return <span class="tile">{a.kind === 'option' ? a.option : a.kind === 'ask' ? '?' : a.kind === 'defer' ? '…' : '“'}</span>;
}

function answerLine(e) {
  if (e.status === 'open') return 'Open now';
  if (e.status === 'cancelled') return 'Cancelled in the terminal';
  const a = e.answer;
  const w = a.words ? ` · ${a.words}` : '';
  if (a.kind === 'option') return <><b>{a.option} · {a.label}</b>{w}</>;
  if (a.kind === 'defer') return `Deferred${w}`;
  if (a.kind === 'ask') return <>Asked for more{a.label ? <> · leaning <b>{a.option} · {a.label}</b></> : null}{w}</>;
  return `In your words${w}`;
}

function Waiting({ sitting }) {
  const done = sitting.findLast((e) => e.status === 'answered');
  return (
    <div class="msg">
      <h2>{done ? 'Sent.' : 'No question open.'}</h2>
      {done ? <p>{done.id}: {answerLine(done)}</p> : null}
      <p>The next question will appear here. Keep this tab open.</p>
    </div>
  );
}

function Unsent({ id, words: w }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="unsent frame">
      <figure class="blk"><figcaption>Your unsent words for {id}</figcaption><pre>{w}</pre></figure>
      <button class="btn" type="button" onClick={() => navigator.clipboard?.writeText(w).then(() => setCopied(true), () => {})}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function arrange(el, n, wide) {
  const w = el.clientWidth;
  const min = wide ? 320 : 180;
  if (w >= parseFloat(getComputedStyle(el).getPropertyValue('--label')) + n * (min + 10)) return '';
  return n >= 3 && w >= 2 * min + 10 ? 'pairs' : 'stacked';
}

const FIXED = [['get', 'What you get'], ['cost', 'What it costs'], ['undo', 'Undo']];

function Question({ token, q, lean }) {
  const [pick, setPick] = useState(lean >= 0 && !q.hard_to_undo ? String(lean) : null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState(null);
  const self = useRef();
  const wrap = useRef();
  const n = q.options.length;
  const rows = (q.rows || []).map((r, i) => ({ ...r, i })).sort((a, b) => (typeof a.cells[0] === 'string' ? 0 : 1) - (typeof b.cells[0] === 'string' ? 0 : 1));
  const wide = rows.some((r) => typeof r.cells[0] !== 'string' && WIDE.has(r.cells[0].kind));
  const all = [...FIXED.map(([key, label]) => ({ key, label })), ...rows.map((r) => ({ key: `rows[${r.i}]`, label: r.label, row: r }))];
  const k = all.length + 1;

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setLayout(arrange(wrap.current, n, wide)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  // Keys act only inside the question holding focus, so the first to arrive takes it when nothing else has it.
  useEffect(() => { if (document.activeElement === document.body) self.current.focus({ preventScroll: true }); }, []);

  const choose = (p) => { setPick(p); setMsg(''); };

  async function send(ask) {
    const w = words[token] || '';
    const p = pick ?? (w.trim() ? 'text' : null);
    if (p === null && !ask) return setMsg('Pick an option, Defer, or write your answer.');
    const option = p === null || p === 'defer' || p === 'text' ? {} : { option: +p };
    const body = ask ? { kind: 'ask', words: w, ...option } : option.option === undefined ? { kind: p, words: w } : { kind: 'option', ...option, words: w };
    setBusy(true);
    sending.add(token);
    try {
      const r = await fetch(`/api/q/${token}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json();
      if (r.status === 400) setMsg(out.error); // 200 and 410: the next event redraws
      if (r.status === 200) { sent.add(token); unsent = []; }
    } catch {
      setMsg('kban is not reachable. Your words stay here: send again once it is back.');
    }
    sending.delete(token);
    setBusy(false);
    repaint();
  }

  function keys(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return send(false); }
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea')) return;
    const i = +e.key - 1;
    if (i >= 0 && i < n) { e.preventDefault(); return choose(String(i)); }
    const opt = e.target.closest('.opt');
    if (opt && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(opt.dataset.i); }
  }

  const cell = (o, i, r) => {
    if (!r.row) return <div class="cell" data-row={r.key} data-path={`options[${i}].${r.key}`}><Inline class="cl" src={r.label} /><Inline src={o[r.key]} /></div>;
    const c = r.row.cells[i];
    const path = `rows[${r.row.i}].cells[${i}]`;
    return typeof c === 'string'
      ? <div class="cell" data-row={r.key} data-path={path}><Inline class="cl" src={r.label} /><Inline src={c} /></div>
      : <div class="cell" data-row={r.key}><Inline class="cl" src={r.label} /><Block b={c} path={path} token={token} /></div>;
  };
  const leaned = pick === null && lean >= 0;
  const echo = pick === null ? (leaned ? <>You leaned to <b>{L[lean]} · <Inline src={q.options[lean].label} /></b>. Pick it to decide.</> : 'Pick an option or write an answer.')
    : pick === 'defer' ? <><b>Defer</b> until you see the plan.</>
    : pick === 'text' ? <><b>None of these:</b> your answer, in the box.</>
    : <b>{L[+pick]} · <Inline src={q.options[+pick].label} /></b>;

  return (
    <article class="q" data-q={q.id} data-token={token} tabIndex={-1} ref={self} onKeyDown={keys}>
      <Inline tag="h1" src={q.question} />
      {q.hard_to_undo
        ? <p class="rec"><span class="pill"><span class="dot hot" />Hard to undo</span></p>
        : <p class="rec"><span class="k">Recommended</span><span class="tile">A</span><Inline src={q.say_ok} /></p>}
      <div class="sheet">
        <div class="lab">Today</div><Inline tag="div" class="val" src={q.today} />
        <div class="lab">Problem</div><Inline tag="div" class="val" src={q.problem} />
        {q.context?.length ? <><div class="lab">Context</div><div class="val ctx">{q.context.map((b, i) => <Block b={b} path={`context[${i}]`} framed token={token} />)}</div></> : null}
      </div>
      <div class="optwrap" ref={wrap}>
        <div class={`opts${wide ? ' wide' : ''}${layout ? ' ' + layout : ''}`} role="radiogroup" aria-label="Options"
          style={`--k: ${k}; grid-template-columns: var(--label) repeat(${n}, minmax(0, 1fr)); grid-template-rows: repeat(${k}, auto)`}>
          {all.map((r, j) => <Inline tag="div" class="rl" style={`grid-row: ${j + 2}`} src={r.label} />)}
          {q.options.map((o, i) => (
            <div class="opt" role="radio" tabIndex={0} aria-checked={String(pick === String(i))} data-i={i}
              style={`grid-column: ${i + 2}; grid-row: 1 / span ${k}`} onClick={(e) => e.target.closest('a') || choose(String(i))}>
              <div class="ch"><span class="tile">{L[i]}</span><Inline class="lbl" src={o.label} />{i === 0 && !q.hard_to_undo ? <span class="rtag">Recommended</span> : null}</div>
              {all.map((r) => cell(o, i, r))}
            </div>
          ))}
        </div>
      </div>
      {q.evidence?.length || q.detail?.length ? (
        <div class="more">
          {q.evidence?.length ? (
            <details class="fold"><summary>Evidence<span class="meta">{q.evidence.length}</span></summary>
              <ul class="ev">{q.evidence.map((e) => {
                const m = e.match(/^(\S*[:/.]\S*)(?:\s+[-–—:]\s+|\s+)([\s\S]*)$/);
                return m ? <li><span class="ref">{m[1]}</span><Inline class="note" src={m[2]} /></li> : <li><Inline class="note" src={e} /></li>;
              })}</ul>
            </details>
          ) : null}
          {q.detail?.length ? (
            <details class="fold"><summary>Detail<span class="meta">{q.detail.length}</span></summary>
              <div class="detail">{q.detail.map((b, i) => <Block b={b} path={`detail[${i}]`} framed={b.kind !== 'text'} token={token} />)}</div>
            </details>
          ) : null}
        </div>
      ) : null}
      <form class="answer" onSubmit={(e) => { e.preventDefault(); send(e.submitter?.dataset.ask === '1'); }}>
        <div class="segmented" role="group" aria-label="Answer">
          {q.options.map((o, i) => <button type="button" data-p={i} aria-pressed={String(pick === String(i))} title={o.label} onClick={() => choose(String(i))}>{L[i]}</button>)}
          <span class="sep" />
          <button type="button" data-p="defer" aria-pressed={String(pick === 'defer')} onClick={() => choose('defer')}>Defer</button>
          <button type="button" data-p="text" aria-pressed={String(pick === 'text')} onClick={() => choose('text')}>None of these</button>
        </div>
        <div class="echo">{echo}</div>
        <Field tag="textarea" class="words" rows={1} spellcheck placeholder="Your words (optional)" value={words[token] || ''}
          onInput={(e) => { const t = e.currentTarget; words[token] = t.value; t.style.height = ''; t.style.height = `${Math.min(t.scrollHeight + 2, 160)}px`; }} />
        <button class="btn" type="submit" data-ask="1" disabled={busy} title="Send it back for more: plainer, or answering your words. A picked option goes as a lean.">Ask</button>
        <button class="btn primary" type="submit" disabled={busy}>Send</button>
        <div class="status" role="status">{msg}</div>
        <div class="keys"><span><kbd>1</kbd>-<kbd>{n}</kbd> pick</span><span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> send</span>
          <span>To answer in the terminal instead, press Esc there.</span></div>
      </form>
    </article>
  );
}
