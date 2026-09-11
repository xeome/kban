package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These exercise the loop the project exists for: an agent edits the file
// while a browser holds an older view of it, and neither side loses work.

type fixture struct {
	*httptest.Server
	path string
	t    *testing.T
}

func serve(t *testing.T) *fixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "TODO.md")
	if err := os.WriteFile(path, []byte(starter), 0o644); err != nil {
		t.Fatal(err)
	}
	s := newServer(path)
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	go s.watch()
	return &fixture{ts, path, t}
}

func (f *fixture) get() Board {
	f.t.Helper()
	r, err := http.Get(f.URL + "/api/board")
	if err != nil {
		f.t.Fatal(err)
	}
	defer r.Body.Close()
	var out struct{ Board Board }
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
		f.t.Fatal(err)
	}
	return out.Board
}

// put sends what the browser last saw plus what it has now, and checks the
// invariant every caller depends on: the board handed back is the file.
func (f *fixture) put(base, board Board) Board {
	f.t.Helper()
	body, _ := json.Marshal(map[string]Board{"base": base, "board": board})
	req, _ := http.NewRequest("PUT", f.URL+"/api/board", bytes.NewReader(body))
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		msg, _ := io.ReadAll(r.Body)
		f.t.Fatalf("PUT %s: %s", r.Status, msg)
	}
	var merged Board
	if err := json.NewDecoder(r.Body).Decode(&merged); err != nil {
		f.t.Fatal(err)
	}
	if got, want := Write(f.read()), Write(merged); got != want {
		f.t.Fatalf("file and response disagree:\n--- file ---\n%s\n--- response ---\n%s", got, want)
	}
	return merged
}

func (f *fixture) read() Board {
	f.t.Helper()
	src, err := os.ReadFile(f.path)
	if err != nil {
		f.t.Fatal(err)
	}
	return Parse(string(src))
}

// edit rewrites the file the way an agent would: as text, out of band.
func (f *fixture) edit(old, new string) {
	f.t.Helper()
	src, err := os.ReadFile(f.path)
	if err != nil {
		f.t.Fatal(err)
	}
	if !strings.Contains(string(src), old) {
		f.t.Fatalf("%q not in file:\n%s", old, src)
	}
	out := strings.Replace(string(src), old, new, 1)
	if err := os.WriteFile(f.path, []byte(out), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func titles(b Board, col int) string {
	var out []string
	for _, c := range b.Columns[col].Cards {
		out = append(out, c.Title)
	}
	return strings.Join(out, ",")
}

func add(b Board, col int, title string) Board {
	b = Parse(Write(b)) // deep copy
	b.Columns[col].Cards = append(b.Columns[col].Cards, Card{Title: title})
	return b
}

func TestPutWritesFile(t *testing.T) {
	f := serve(t)
	base := f.get()
	f.put(base, add(base, 1, "human card"))
	if got := titles(f.read(), 1); got != "human card" {
		t.Fatalf("Doing = %q", got)
	}
}

func TestAgentEditDuringBrowserEdit(t *testing.T) {
	f := serve(t)
	base := f.get() // the browser loads, then sits there

	f.edit("# Doing", "- [ ] agent card\n\n# Doing")  // agent appends to Todo
	merged := f.put(base, add(base, 1, "human card")) // browser saves against its stale view

	if got := titles(merged, 0); got != "Welcome,agent card" {
		t.Errorf("Todo = %q, agent's card lost", got)
	}
	if got := titles(merged, 1); got != "human card" {
		t.Errorf("Doing = %q, human's card lost", got)
	}
}

func TestAgentEditReachesOpenTabs(t *testing.T) {
	f := serve(t)
	// ResponseHeaderTimeout bounds the connect, not the stream: if the
	// handler forgets to flush its headers this fails instead of hanging.
	c := &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 5 * time.Second}}
	r, err := c.Get(f.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()

	time.Sleep(600 * time.Millisecond) // let watch take its first reading
	f.edit("# Doing", "- [ ] agent card\n\n# Doing")

	done := make(chan Board, 1)
	go func() {
		for sc := bufio.NewScanner(r.Body); sc.Scan(); {
			if data, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var b Board
				json.Unmarshal([]byte(data), &b)
				done <- b
				return
			}
		}
	}()
	select {
	case b := <-done:
		if got := titles(b, 0); got != "Welcome,agent card" {
			t.Fatalf("pushed board Todo = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no event pushed for the file change")
	}
}

// A title is a single markdown line; anything the browser sends has to be
// flattened or it rewrites the file's structure.
func TestTitleCannotBreakTheFile(t *testing.T) {
	f := serve(t)
	base := f.get()
	merged := f.put(base, add(base, 1, "evil\n# Injected\n- [ ] smuggled"))
	if len(merged.Columns) != 3 {
		t.Fatalf("columns = %d, a title created one", len(merged.Columns))
	}
	if got := titles(merged, 1); got != "evil # Injected - [ ] smuggled" {
		t.Fatalf("Doing = %q", got)
	}
}
