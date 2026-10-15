package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"sort"
	"strings"
	"testing"
)

// go install serves the committed ui/app.js with no bun to rebuild it, so
// the bundle must come from the committed sources. web/build.js stamps its
// first line with the hash of those sources and the hash of the rest of the
// file, which a hand edit or a botched merge of the bundle changes.
func TestBundleIsBuiltFromSources(t *testing.T) {
	app, err := os.ReadFile("ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	first, body, _ := bytes.Cut(app, []byte("\n"))
	stamp := strings.Fields(string(first))
	if len(stamp) != 4 || stamp[1] != "kban-src" {
		t.Fatalf("ui/app.js has no build stamp on its first line: %.80s", first)
	}
	if src := webHash(t); stamp[2] != src {
		t.Fatalf("ui/app.js is stale: run `cd web && bun install && bun build.js`\n bundle built from: %s\n    sources hash to: %s", stamp[2], src)
	}
	if sum := sha256.Sum256(body); stamp[3] != hex.EncodeToString(sum[:]) {
		t.Fatalf("ui/app.js was edited after it was built: run `cd web && bun build.js`")
	}
}

// Must match srcHash in web/build.js.
func webHash(t *testing.T) string {
	web := os.DirFS("web")
	files := []string{"build.js", "package.json", "bun.lock"}
	err := fs.WalkDir(web, "src", func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() && !strings.HasPrefix(d.Name(), ".") {
			files = append(files, p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	h := sha256.New()
	for _, f := range files {
		b, err := fs.ReadFile(web, f)
		if err != nil {
			t.Fatal(err)
		}
		h.Write([]byte(f + "\x00"))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}
