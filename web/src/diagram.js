// ui/mermaid.js is large, so it is loaded by a script tag on the first
// diagram, not bundled into app.js.

let loading = null;
function load() {
  loading ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = '/mermaid.js';
    s.onload = () => ok(window.mermaid);
    s.onerror = () => { loading = null; fail(new Error('mermaid.js did not load')); };
    document.head.append(s);
  }).then((mermaid) => {
    mermaid.initialize(config());
    return mermaid;
  });
  return loading;
}

// An agent writes the source. securityLevel strict sanitizes labels, and the
// keys added to secure cannot be set by an %%{init}%% line: htmlLabels and
// flowchart would turn HTML labels back on and make the page fetch an <img>
// URL, and themeCSS, fontFamily, altFontFamily and themeVariables reach the
// page's CSS, where a url() fetches too.
function config() {
  const off = { useMaxWidth: false };
  return {
    startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true,
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'flowchart',
      'themeCSS', 'fontFamily', 'altFontFamily', 'themeVariables'],
    flowchart: { ...off, htmlLabels: false, curve: 'basis' }, sequence: off, class: off, state: off, er: off, gantt: off,
    journey: off, pie: off, mindmap: off, timeline: off, gitGraph: off, quadrantChart: off, xyChart: off, requirement: off,
    theme: 'base', look: 'classic', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', themeVariables: theme(),
  };
}

// The theme changed: Mermaid takes the tokens as they resolve now, and every
// diagram on the page draws again in them.
export async function retheme() {
  if (!loading) return;
  (await loading).initialize(config());
  prune();
  for (const box of boxes.keys()) draw(box);
}

// Mermaid wants colours, not var(), so the tokens are read as resolved now.
function theme() {
  const c = (name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(--${name})`;
    document.body.append(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v;
  };
  const [panel, raised, text, dim, bright, rule] = ['panel', 'raised', 'text', 'dim', 'bright', 'line'].map(c);
  return {
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: '13px', background: panel,
    primaryColor: raised, primaryTextColor: text, primaryBorderColor: dim, secondaryColor: panel, tertiaryColor: panel,
    lineColor: dim, textColor: text, mainBkg: raised, nodeBorder: dim, clusterBkg: panel, clusterBorder: rule,
    edgeLabelBackground: panel, titleColor: bright, noteBkgColor: raised, noteTextColor: text, noteBorderColor: dim,
    actorBkg: raised, actorBorder: dim, actorTextColor: text, actorLineColor: dim, signalColor: dim, signalTextColor: text,
    labelBoxBkgColor: raised, labelBoxBorderColor: dim, labelTextColor: text, loopTextColor: text,
  };
}

let n = 0;
const boxes = new Map(); // box -> source, to draw again on a theme change
const due = new Set();

// Mermaid measures text inside the box it is given: mounted on body, a
// flex row here, its box squeezed the panel while it drew.
export function diagram(src) {
  prune();
  const box = document.createElement('div');
  box.className = 'scroll diagram';
  const wait = document.createElement('span');
  wait.className = 'wait';
  wait.textContent = 'Drawing the diagram…';
  box.append(wait);
  boxes.set(box, src);
  sizes.observe(box);
  draw(box);
  return box;
}

// A box with no size, under display:none or not yet shown, measures every
// label as nothing: it draws once it has one.
async function draw(box) {
  const src = boxes.get(box);
  const id = `kd${++n}`;
  try {
    const mermaid = await load();
    if (!box.clientWidth) return due.add(box);
    const { svg } = await mermaid.render(id, src, box);
    box.innerHTML = svg; // Mermaid's own output, sanitized under securityLevel strict
    fit(box);
  } catch {
    const pre = document.createElement('pre');
    pre.textContent = src;
    box.replaceChildren(pre);
  }
}

// Only the svg's own width is set, and only when it changes, so a settled
// page stays still.
function fit(box) {
  const svg = box.querySelector('svg');
  const natural = svg?.viewBox.baseVal?.width;
  if (!natural) return;
  const width = `${Math.max(natural * 0.8, Math.min(natural, box.clientWidth))}px`;
  if (svg.style.width !== width) svg.style.width = width;
}
const sizes = new ResizeObserver((entries) => {
  for (const { target: box } of entries) {
    if (box.clientWidth && due.delete(box)) draw(box);
    else fit(box);
  }
});

// Md sets its html again on every change, leaving the old boxes behind.
function prune() {
  for (const box of boxes.keys()) {
    if (!box.isConnected) {
      boxes.delete(box);
      due.delete(box);
      sizes.unobserve(box);
    }
  }
}
