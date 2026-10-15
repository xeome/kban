import MarkdownIt from 'markdown-it';

// Board text is untrusted: an agent may paste anything. An image would fetch
// a remote URL, and markdown-it's own link check lets through ftp:, app
// schemes and paths on this server.
const it = new MarkdownIt({ html: false, breaks: true, linkify: true });
it.disable('image');
it.validateLink = (url) => /^(https?:|mailto:)/i.test(url);
// The card face is not a tab stop, so its links must not be either.
it.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noopener noreferrer');
  if (env.face) tokens[i].attrSet('tabindex', '-1');
  return self.renderToken(tokens, i, opts);
};

// Every render runs this for every card and comment; most never change.
// ponytail: unbounded, one entry per distinct text seen this session; an LRU
// if a session ever edits enough text for it to matter.
const seen = new Map();
export function md(src, face = false) {
  const key = `${+face}${src}`;
  if (!seen.has(key)) seen.set(key, it.render(src, { face }).trim());
  return seen.get(key);
}
