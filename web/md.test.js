import { expect, test } from 'bun:test';
import { md } from './src/md.js';

test.each([
  ['bold', 'a **b** c', '<p>a <strong>b</strong> c</p>'],
  ['italic', 'a *b* c', '<p>a <em>b</em> c</p>'],
  ['code', 'run `go test`', '<p>run <code>go test</code></p>'],
  ['fenced code', '```\nx < 1\n```', '<pre><code>x &lt; 1\n</code></pre>'],
  ['list', '- a\n- b', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'],
  ['numbered list', '1. a\n2. b', '<ol>\n<li>a</li>\n<li>b</li>\n</ol>'],
  ['heading', '## Risk', '<h2>Risk</h2>'],
  ['quote', '> said', '<blockquote>\n<p>said</p>\n</blockquote>'],
  ['link', '[docs](https://e.com/d)', '<p><a href="https://e.com/d" target="_blank" rel="noopener noreferrer">docs</a></p>'],
  ['bare url', 'see https://e.com/d', '<p>see <a href="https://e.com/d" target="_blank" rel="noopener noreferrer">https://e.com/d</a></p>'],
  ['mailto', '[me](mailto:a@b.c)', '<p><a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">me</a></p>'],
  ['table', '| a | b |\n|---|---|\n| 1 | 2 |', '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>'],
  ['a single newline stays a line break', 'tier: 2\nbranch: x', '<p>tier: 2<br>\nbranch: x</p>'],
  ['a file name is not a link', 'see README.md', '<p>see README.md</p>'],
])('%s', (_, src, html) => {
  expect(md(src)).toBe(html);
});

test.each([
  ['ftp link', '[a](ftp://x/y)', '[a](ftp://x/y)'],
  ['app link', '[a](vscode://file/x)', '[a](vscode://file/x)'],
  ['relative link to the API', '[a](/api/board)', '[a](/api/board)'],
  ['protocol-relative link', '[a](//host/x)', '[a](//host/x)'],
  ['autolink to another scheme', '<ssh://h>', '&lt;ssh://h&gt;'],
  ['javascript link', '[a](javascript:alert(1))', '[a](javascript:alert(1))'],
  ['raw HTML', '<img src=x onerror=alert(1)><script>x</script>', '&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;x&lt;/script&gt;'],
  ['image', '![a](http://x/y.png)', '<a href="http://x/y.png"'],
])('%s', (_, src, shown) => {
  const html = md(src);
  expect(html).toContain(shown);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) expect(href).toMatch(/^(https?:|mailto:)/);
});
