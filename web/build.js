// Builds ../ui/app.js and ../ui/mermaid.js, which go:embed serves as is, so
// installing kban needs no bun. Each first line holds a hash of that
// bundle's inputs and a hash of the rest of the file; bundle_test.go
// recomputes both to fail when a committed bundle is stale or was edited by hand.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;

// Must match bundles and webHash in bundle_test.go. mermaid.js's entry is
// written below, so build.js is its entry file.
const shared = ['build.js', 'package.json', 'bun.lock'];
const inputs = {
  'app.js': readdirSync(join(dir, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll('\\', '/'))
    .concat(shared),
  'mermaid.js': shared,
};
function srcHash(files) {
  const h = createHash('sha256');
  for (const f of files.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) h.update(f).update('\0').update(readFileSync(join(dir, f)));
  return h.digest('hex');
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// An IIFE: as a classic script, top-level names would become globals.
async function build(name, opts) {
  const out = await Bun.build({ format: 'iife', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, ...opts });
  if (!out.success) {
    console.error(...out.logs);
    process.exit(1);
  }
  const body = await out.outputs[0].text();
  writeFileSync(join(dir, '../ui', name), `// kban-src ${srcHash(inputs[name])} ${sha256(body)}\n${body}`);
}

await build('app.js', { entrypoints: [join(dir, 'src/main.js')], jsx: { runtime: 'automatic', importSource: 'preact' } });
// Mermaid is 5 MB, so it is its own file, which diagram.js loads on the
// first diagram and reads back as window.mermaid.
const entry = join(dir, 'mermaid-entry.js');
await build('mermaid.js', { entrypoints: [entry], files: { [entry]: "import m from 'mermaid'; window.mermaid = m;" } });
