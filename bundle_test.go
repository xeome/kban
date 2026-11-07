package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// go install serves the committed ui/app.js and ui/mermaid.js with no bun
// to rebuild them, so each must come from the committed sources. web/build.js
// stamps its first line with the hash of that bundle's inputs and the hash of
// the rest of the file, which a hand edit or a botched merge of the bundle changes.
func TestBundleIsBuiltFromSources(t *testing.T) {
	shared := []string{"build.js", "package.json", "bun.lock"}
	var src []string
	err := fs.WalkDir(os.DirFS("web"), "src", func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() && !strings.HasPrefix(d.Name(), ".") {
			src = append(src, p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	// Must match inputs in web/build.js. mermaid.js's entry is written in build.js.
	for name, inputs := range map[string][]string{"ui/app.js": append(src, shared...), "ui/mermaid.js": shared} {
		app, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		first, body, _ := bytes.Cut(app, []byte("\n"))
		stamp := strings.Fields(string(first))
		if len(stamp) != 4 || stamp[1] != "kban-src" {
			t.Fatalf("%s has no build stamp on its first line: %.80s", name, first)
		}
		if want := webHash(t, inputs); stamp[2] != want {
			t.Errorf("%s is stale: run `cd web && bun install && bun build.js`\n bundle built from: %s\n    sources hash to: %s", name, stamp[2], want)
		}
		if sum := sha256.Sum256(body); stamp[3] != hex.EncodeToString(sum[:]) {
			t.Errorf("%s was edited after it was built: run `cd web && bun build.js`", name)
		}
	}
}

// Must match srcHash in web/build.js.
func webHash(t *testing.T, files []string) string {
	files = slices.Sorted(slices.Values(files))
	h := sha256.New()
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join("web", f))
		if err != nil {
			t.Fatal(err)
		}
		h.Write([]byte(f + "\x00"))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}
