// Builds ../ui/app.js, which go:embed serves as is, so installing kban needs
// no bun. The first line holds a hash of every input and a hash of the rest
// of the file; bundle_test.go recomputes both to fail when the committed
// bundle is stale or was edited by hand.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;

// Must match webHash in bundle_test.go.
function srcHash() {
  const files = readdirSync(join(dir, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll('\\', '/'))
    .concat('build.js', 'package.json', 'bun.lock')
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const h = createHash('sha256');
  for (const f of files) h.update(f).update('\0').update(readFileSync(join(dir, f)));
  return h.digest('hex');
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// An IIFE: as a classic script, top-level names would become globals.
const out = await Bun.build({
  entrypoints: [join(dir, 'src/main.js')],
  format: 'iife',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  jsx: { runtime: 'automatic', importSource: 'preact' },
});
if (!out.success) {
  console.error(...out.logs);
  process.exit(1);
}
const body = await out.outputs[0].text();
writeFileSync(join(dir, '../ui/app.js'), `// kban-src ${srcHash()} ${sha256(body)}\n${body}`);
