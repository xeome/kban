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
	path := filepath.Join(t.TempDir(), "TODO.json")
	if err := os.WriteFile(path, []byte(Write(starter("TODO.json"))), 0o644); err != nil {
		t.Fatal(err)
	}
	s := newServer(path)
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	go s.watch()
	return &fixture{ts, path, t}
}

func (f *fixture) getState() state {
	f.t.Helper()
	r, err := http.Get(f.URL + "/api/board")
	if err != nil {
		f.t.Fatal(err)
	}
	defer r.Body.Close()
	var out state
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
		f.t.Fatal(err)
	}
	return out
}

func (f *fixture) get() Board {
	f.t.Helper()
	st := f.getState()
	if st.Board == nil {
		f.t.Fatalf("no board: %s", st.Error)
	}
	return *st.Board
}

func (f *fixture) send(base, board Board) *http.Response {
	f.t.Helper()
	body, _ := json.Marshal(map[string]Board{"base": base, "board": board})
	req, _ := http.NewRequest("PUT", f.URL+"/api/board", bytes.NewReader(body))
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}

// put sends what the browser last saw plus what it has now, and checks the
// invariant every caller depends on: the board handed back is the file.
func (f *fixture) put(base, board Board) Board {
	f.t.Helper()
	r := f.send(base, board)
	defer r.Body.Close()
	body, _ := io.ReadAll(r.Body)
	if r.StatusCode != 200 {
		f.t.Fatalf("PUT %s: %s", r.Status, body)
	}
	file, _ := os.ReadFile(f.path)
	if string(file) != string(body) {
		f.t.Fatalf("file and response disagree:\n--- file ---\n%s\n--- response ---\n%s", file, body)
	}
	return f.read()
}

func (f *fixture) read() Board {
	f.t.Helper()
	src, err := os.ReadFile(f.path)
	if err != nil {
		f.t.Fatal(err)
	}
	b, err := Parse(string(src))
	if err != nil {
		f.t.Fatal(err)
	}
	return b
}

// agent rewrites the file out of band, in its own formatting and in place.
func (f *fixture) agent(edit func(*Board)) {
	f.t.Helper()
	b := f.read()
	edit(&b)
	out, _ := json.MarshalIndent(b, "", "\t")
	if err := os.WriteFile(f.path, out, 0o644); err != nil {
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

func clone(b Board) Board {
	out, _ := Parse(Write(b))
	return out
}

func add(b Board, col int, title string) Board {
	b = clone(b)
	b.Columns[col].Cards = append(b.Columns[col].Cards, Card{Title: title})
	return b
}

func TestStarterNamesItsFile(t *testing.T) {
	if got := starter("board.json").Instructions; !strings.Contains(got, "> t && mv t board.json") {
		t.Fatalf("instructions = %q, want the agent's command to name the served file", got)
	}
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

	f.agent(func(b *Board) { b.Columns[0].Cards = append(b.Columns[0].Cards, Card{Title: "agent card"}) })
	merged := f.put(base, add(base, 1, "human card")) // browser saves against its stale view

	if got := titles(merged, 0); got != "Welcome,agent card" {
		t.Errorf("Todo = %q, agent's card lost", got)
	}
	if got := titles(merged, 1); got != "human card" {
		t.Errorf("Doing = %q, human's card lost", got)
	}
}

func TestAgentCommentDuringBrowserComment(t *testing.T) {
	f := serve(t)
	base := f.get()
	agent := Comment{"claude", "2026-10-15T14:02:00+03:00", "fixed on card/x"}
	human := Comment{"me", "2026-10-15T14:03:00+03:00", "thanks"}

	f.agent(func(b *Board) { c := &b.Columns[0].Cards[0]; c.Comments = append(c.Comments, agent) })
	mine := clone(base)
	c := &mine.Columns[0].Cards[0]
	c.Comments = append(c.Comments, human)
	f.put(base, mine)

	got := f.read().Columns[0].Cards[0].Comments
	n := len(got)
	if n < 2 || got[n-2] != agent || got[n-1] != human {
		t.Fatalf("comments = %+v, want the agent's then the human's at the end", got)
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
	events := make(chan state, 4)
	go func() {
		for sc := bufio.NewScanner(r.Body); sc.Scan(); {
			if data, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var st state
				json.Unmarshal([]byte(data), &st)
				events <- st
			}
		}
	}()
	next := func() state {
		select {
		case st := <-events:
			return st
		case <-time.After(5 * time.Second):
			t.Fatal("no event pushed for the file change")
			return state{}
		}
	}

	time.Sleep(600 * time.Millisecond) // let watch take its first reading
	f.agent(func(b *Board) { b.Columns[0].Cards = append(b.Columns[0].Cards, Card{Title: "agent card"}) })
	if st := next(); st.Board == nil || titles(*st.Board, 0) != "Welcome,agent card" {
		t.Fatalf("pushed %+v, want the agent's card in Todo", st)
	}

	os.WriteFile(f.path, []byte("{\n  \"columns\": [,\n"), 0o644)
	if st := next(); st.Board != nil || !strings.Contains(st.Error, "line 2") {
		t.Fatalf("pushed %+v, want the parse error with its line", st)
	}
}

// The browser keeps editing its own copy between saves, so the base it
// sends is what it typed, not what the server stored. If the server
// rewrites anything it stores, that base stops matching and an edit
// becomes a second card.
func TestTitleIsStoredAsTyped(t *testing.T) {
	f := serve(t)
	base := f.get()
	typed := add(base, 1, "a\n# b ")
	f.put(base, typed)
	more := clone(typed)
	more.Columns[1].Cards[0].Title = "a\n# b c"
	merged := f.put(typed, more)
	if len(merged.Columns) != 3 {
		t.Fatalf("columns = %d, a title created one", len(merged.Columns))
	}
	if got := titles(merged, 1); got != "a\n# b c" {
		t.Fatalf("Doing = %q, want the one card, as typed", got)
	}
}

func TestInvalidFileIsNeverOverwritten(t *testing.T) {
	f := serve(t)
	base := f.get()
	broken := []byte("{\n  \"columns\": [\n    {\"title\": \"Todo\", \"cards\": [], \"colour\": \"red\"}\n  ]\n}\n")
	os.WriteFile(f.path, broken, 0o644)

	r := f.send(base, add(base, 1, "human card"))
	r.Body.Close()
	if r.StatusCode != http.StatusConflict {
		t.Errorf("PUT on a broken file: %s, want 409", r.Status)
	}
	if got, _ := os.ReadFile(f.path); !bytes.Equal(got, broken) {
		t.Errorf("file was rewritten:\n%s", got)
	}
	if st := f.getState(); st.Board != nil || !strings.Contains(st.Error, `line 3: json: unknown field "colour"`) {
		t.Errorf("GET = %+v, want the error with its line", st)
	}
}
