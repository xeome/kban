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
	return serveIn(t, t.TempDir())
}

func serveIn(t *testing.T, dir string) *fixture {
	t.Helper()
	path := filepath.Join(dir, "TODO.json")
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

// id is what a tab sends back on every save: the board's identity, as the
// GET that loaded it gave it.
func (f *fixture) id() string {
	f.t.Helper()
	r, err := http.Get(f.URL + "/api/board")
	if err != nil {
		f.t.Fatal(err)
	}
	defer r.Body.Close()
	var got map[string]any
	json.NewDecoder(r.Body).Decode(&got)
	id, _ := got["fileID"].(string)
	return id
}

func (f *fixture) send(base, board Board) *http.Response {
	f.t.Helper()
	return f.sendAs(f.id(), base, board)
}

// sendAs is a save from a tab that loaded the board identified as id.
func (f *fixture) sendAs(id string, base, board Board) *http.Response {
	f.t.Helper()
	body, _ := json.Marshal(map[string]any{"fileID": id, "base": base, "board": board})
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
	b.Columns[col].Cards = append(b.Columns[col].Cards, Card{ID: newID(), Title: title})
	return b
}

func TestStarter(t *testing.T) {
	b := starter("board.json")
	if got := b.Instructions; !strings.Contains(got, "kban move") || !strings.Contains(got, "-f board.json") || strings.Contains(got, "jq") {
		t.Errorf("instructions = %q, want the kban commands on the served file, and no jq", got)
	}
	if _, err := Parse(Write(b)); err != nil {
		t.Errorf("the starter does not read back: %v", err)
	}
}

// A card with no id from the browser would make the file unreadable.
func TestPutRefusesIDless(t *testing.T) {
	f := serve(t)
	base := f.get()
	was, _ := os.ReadFile(f.path)
	idless := add(base, 1, "human card")
	idless.Columns[1].Cards[0].ID = ""
	stale := clone(base)
	stale.Columns[0].Cards[0].ID = ""
	for _, req := range [][2]Board{{base, idless}, {stale, base}} {
		r := f.send(req[0], req[1])
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "reload this page") {
			t.Errorf("PUT with a card with no id: %s %s, want 400 and reload", r.Status, body)
		}
	}
	if got, _ := os.ReadFile(f.path); !bytes.Equal(got, was) {
		t.Errorf("file was rewritten:\n%s", got)
	}
}

// A tab keeps its undo steps and a failed save across a reconnect. If
// another kban took the port meanwhile, they belong to another board.
func TestPutRefusesAnotherBoard(t *testing.T) {
	f, other := serve(t), serve(t)
	base := f.get()
	was, _ := os.ReadFile(f.path)
	r := f.sendAs(other.id(), base, add(base, 1, "card from another board"))
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusPreconditionFailed || !strings.Contains(string(body), f.path) {
		t.Errorf("PUT from a tab on another board: %s %s, want 412 naming %s", r.Status, body, f.path)
	}
	if got, _ := os.ReadFile(f.path); !bytes.Equal(got, was) {
		t.Errorf("file was rewritten:\n%s", got)
	}
}

// A tab still running the page from before saves named their board, or one
// whose board has not loaded yet, has only seen this kban.
func TestPutAcceptsTabWithoutID(t *testing.T) {
	f := serve(t)
	base := f.get()
	if r := f.sendAs("", base, add(base, 1, "card")); r.StatusCode != 200 {
		t.Errorf("PUT naming no board: %s, want 200", r.Status)
	}
}

// The same file is the same board however its path is spelled, so a tab
// keeps its edits when kban restarts on it from a symlinked directory.
func TestSymlinkedPathIsTheSameBoard(t *testing.T) {
	f := serve(t)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(filepath.Dir(f.path), link); err != nil {
		t.Skip(err)
	}
	s := newServer(filepath.Join(link, "TODO.json"))
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	viaLink := &fixture{ts, filepath.Join(link, "TODO.json"), t}
	base := f.get()
	if r := f.sendAs(viaLink.id(), base, add(base, 1, "card")); r.StatusCode != 200 {
		t.Errorf("PUT from a tab that loaded the same file through a symlink: %s, want 200", r.Status)
	}
}

// A path JSON cannot carry intact still names its board.
func TestSaveUnderNonUTF8Path(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "caf\xe9")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Skip(err) // a filesystem that takes only UTF-8 names
	}
	f := serveIn(t, dir)
	base := f.get()
	f.put(base, add(base, 1, "card"))
}

// A write lands between a writer's read and its rename. hook makes it land
// there every time instead of once in a while.
func TestCommandDuringSave(t *testing.T) {
	t.Cleanup(func() { beforeRename = func() {} })
	once := func(f func()) {
		beforeRename = func() { beforeRename = func() {}; f() }
	}
	agent := Comment{"claude", "2026-10-15T14:02:00+03:00", "fixed"}
	check := func(f *fixture, want string) {
		t.Helper()
		c := f.read().Columns[0].Cards[0]
		if c.Notes != "typed" || len(c.Comments) != 2 || c.Comments[1].Text != "fixed" {
			t.Errorf("%s: card = %+v, want the notes and the agent comment", want, c)
		}
		if ents, _ := os.ReadDir(filepath.Dir(f.path)); len(ents) != 1 {
			t.Errorf("%s: directory holds %d files, want only the board", want, len(ents))
		}
	}

	f := serve(t)
	base := f.get()
	once(func() {
		f.agent(func(b *Board) { c := &b.Columns[0].Cards[0]; c.Comments = append(c.Comments, agent) })
	})
	mine := clone(base)
	mine.Columns[0].Cards[0].Notes = "typed"
	r := f.send(base, mine)
	r.Body.Close()
	check(f, "agent writes during a PUT")

	f = serve(t)
	base = f.get()
	mine = clone(base)
	mine.Columns[0].Cards[0].Notes = "typed"
	once(func() { f.put(base, mine) })
	if code := cli([]string{"comment", "-f", f.path, "-a", "claude", base.Columns[0].Cards[0].ID, "fixed"}, nil, io.Discard, io.Discard); code != 0 {
		t.Fatalf("comment exited %d", code)
	}
	check(f, "browser saves during a command")
}

func TestPutWritesFile(t *testing.T) {
	f := serve(t)
	os.Chmod(f.path, 0o640)
	base := f.get()
	f.put(base, add(base, 1, "human card"))
	if got := titles(f.read(), 1); got != "human card" {
		t.Fatalf("Doing = %q", got)
	}
	if fi, _ := os.Stat(f.path); fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v, want the file's own 0640 kept", fi.Mode().Perm())
	}
}

func TestAgentEditDuringBrowserEdit(t *testing.T) {
	f := serve(t)
	base := f.get() // the browser loads, then sits there

	f.agent(func(b *Board) {
		b.Columns[0].Cards = append(b.Columns[0].Cards, Card{ID: "agentcrd", Title: "agent card"})
	})
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
	f.agent(func(b *Board) {
		b.Columns[0].Cards = append(b.Columns[0].Cards, Card{ID: "agentcrd", Title: "agent card"})
	})
	if st := next(); st.Board == nil || titles(*st.Board, 0) != "Welcome,agent card" {
		t.Fatalf("pushed %+v, want the agent's card in Todo", st)
	}

	os.WriteFile(f.path, []byte("{\n  \"columns\": [,\n"), 0o644)
	if st := next(); st.Board != nil || !strings.Contains(st.Error, "line 2") {
		t.Fatalf("pushed %+v, want the parse error with its line", st)
	}
}

// Firefox calls a stream open, and the page reloads the board, only once
// its first bytes arrive. A tab that reconnects while the file is quiet
// would say offline until the next change.
func TestStreamSendsOnConnect(t *testing.T) {
	f := serve(t)
	c := &http.Client{Timeout: 2 * time.Second} // a silent stream fails the test instead of hanging it
	r, err := c.Get(f.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	line, err := bufio.NewReader(r.Body).ReadString('\n')
	if err != nil {
		t.Fatalf("the stream sent nothing on connect, with the file unchanged: %v", err)
	}
	if !strings.HasPrefix(line, ":") {
		t.Fatalf("first line %q, want a comment, which EventSource does not deliver as a message", line)
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
