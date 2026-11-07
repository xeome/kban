package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type event struct{ name, data string }

func listen(t *testing.T, url string) <-chan event {
	t.Helper()
	// ResponseHeaderTimeout bounds the connect, not the stream: if the
	// handler forgets to flush its headers this fails instead of hanging.
	c := &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 5 * time.Second}}
	r, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 {
		t.Fatalf("GET %s: %s", url, r.Status)
	}
	t.Cleanup(func() { r.Body.Close() })
	ch := make(chan event, 16)
	go func() {
		defer close(ch)
		name := ""
		for sc := bufio.NewScanner(r.Body); sc.Scan(); {
			if v, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
				name = v
			} else if v, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				ch <- event{name, v}
				name = ""
			}
		}
	}()
	return ch
}

func next(t *testing.T, ch <-chan event) event {
	t.Helper()
	select {
	case e, ok := <-ch:
		if !ok {
			t.Fatal("the stream ended")
		}
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("nothing pushed")
		return event{}
	}
}

func nextBoard(t *testing.T, ch <-chan event) state {
	t.Helper()
	for {
		if e := next(t, ch); e.name == "" {
			var st state
			json.Unmarshal([]byte(e.data), &st)
			return st
		}
	}
}

func nextList(t *testing.T, ch <-chan event) []listed {
	t.Helper()
	for {
		if e := next(t, ch); e.name == "boards" {
			var l []listed
			json.Unmarshal([]byte(e.data), &l)
			return l
		}
	}
}

func newBoardFile(t *testing.T, dir, name, title string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	b := starter(name)
	b.Columns[0].Cards[0].Title = title
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(Write(b)), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func agentAdd(t *testing.T, path, title string) {
	t.Helper()
	if code := cli([]string{"add", "-f", path, "Todo", title}, nil, io.Discard, io.Discard); code != 0 {
		t.Fatalf("add exited %d", code)
	}
}

func getJSON(t *testing.T, url string, v any) int {
	t.Helper()
	r, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	json.NewDecoder(r.Body).Decode(v)
	return r.StatusCode
}

func TestHubServesEachBoardByID(t *testing.T) {
	a := newBoardFile(t, filepath.Join(t.TempDir(), "proj-a"), "TODO.json", "card of A")
	b := newBoardFile(t, filepath.Join(t.TempDir(), "proj-b"), "IDEAS.json", "card of B")
	h, ts := startHub(t, a, b)
	go h.watch()
	apiA, apiB := ts.URL+"/api/b/"+fileID(a), ts.URL+"/api/b/"+fileID(b)

	var got struct {
		File, Project string
		Board         Board
	}
	getJSON(t, apiB+"/board", &got)
	if got.File != "IDEAS.json" || got.Project != "proj-b" || got.Board.Columns[0].Cards[0].Title != "card of B" {
		t.Fatalf("GET B = %+v, want B's board, file and project", got)
	}

	events := listen(t, apiA+"/events")
	nextList(t, events) // sent on open
	wasA, _ := os.ReadFile(a)
	base := got.Board
	r := putTo(t, apiB, base, add(base, 1, "saved to B"))
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("PUT B: %s", r.Status)
	}
	if nowA, _ := os.ReadFile(a); !bytes.Equal(nowA, wasA) {
		t.Errorf("a PUT to B rewrote A:\n%s", nowA)
	}
	if titles(readBoard(t, b), 1) != "saved to B" {
		t.Errorf("B = %s, want the saved card", titles(readBoard(t, b), 1))
	}

	e := next(t, events)
	var l []listed
	json.Unmarshal([]byte(e.data), &l)
	if e.name != "boards" || len(l) != 2 || l[1].Version != stamp(b) {
		t.Errorf("A's stream got %q %s, want a boards event with B at its new version %s", e.name, e.data, stamp(b))
	}
	if v := r.Header.Get("X-Kban-Version"); v != stamp(b) {
		t.Errorf("PUT B answered version %q, want %q, as /api/boards lists it", v, stamp(b))
	}

	unknown := ts.URL + "/api/b/0123456789abcdef"
	if r := putTo(t, unknown, base, add(base, 1, "lost")); r.StatusCode != 404 {
		t.Errorf("PUT to an unregistered id: %s, want 404", r.Status)
	}
	for _, u := range []string{unknown + "/board", unknown + "/events", ts.URL + "/b/0123456789abcdef"} {
		if code := getJSON(t, u, new(any)); code != 404 {
			t.Errorf("GET %s: %d, want 404", u, code)
		}
	}
	if nowA, _ := os.ReadFile(a); !bytes.Equal(nowA, wasA) {
		t.Errorf("a PUT to an unregistered id rewrote A:\n%s", nowA)
	}
}

func TestRegistry(t *testing.T) {
	dir := t.TempDir()
	a := newBoardFile(t, filepath.Join(dir, "a"), "TODO.json", "A")
	b := newBoardFile(t, filepath.Join(dir, "b"), "TODO.json", "B")
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(filepath.Dir(a), link); err != nil {
		t.Skip(err)
	}
	h, ts := startHub(t, a, a, filepath.Join(link, "TODO.json"))
	if src, _ := os.ReadFile(h.registry); strings.Count(string(src), a+"\n") != 1 {
		t.Errorf("registry = %q, want A once", src)
	}
	go h.watch()
	list := func() []listed {
		var l []listed
		getJSON(t, ts.URL+"/api/boards", &l)
		return l
	}
	if l := list(); len(l) != 1 || l[0].ID != fileID(a) || l[0].Project != "a" {
		t.Fatalf("boards = %+v, want A once, however its path is spelled", l)
	}

	events := listen(t, ts.URL+"/api/b/"+fileID(a)+"/events")
	nextList(t, events)
	if err := register(h.registry, b); err != nil {
		t.Fatal(err)
	}
	if l := nextList(t, events); len(l) != 2 || l[1].ID != fileID(b) {
		t.Fatalf("A's stream got %+v, want the list with B appended", l)
	}
	agentAdd(t, a, "after the re-read")
	if st := nextBoard(t, events); st.Board == nil || !strings.Contains(titles(*st.Board, 0), "after the re-read") {
		t.Fatalf("A's stream got %+v after the registry was re-read, want A's change", st)
	}

	bStream := listen(t, ts.URL+"/api/b/"+fileID(b)+"/events")
	os.WriteFile(h.registry, []byte(a+"\n"), 0o644)
	deadline := time.Now().Add(3 * time.Second)
	for len(list()) != 1 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if l := list(); len(l) != 1 || l[0].ID != fileID(a) {
		t.Fatalf("boards = %+v after B's line was deleted, want A alone", l)
	}
	for ended := time.After(3 * time.Second); ; {
		select {
		case _, ok := <-bStream:
			if !ok {
				return
			}
		case <-ended:
			t.Fatal("B's stream is still open after its line was deleted")
		}
	}
}

func TestHostCheck(t *testing.T) {
	a := newBoardFile(t, t.TempDir(), "TODO.json", "A")
	_, ts := startHub(t, a)
	_, port, _ := net.SplitHostPort(ts.Listener.Addr().String())
	id := fileID(a)
	routes := [][2]string{{"GET", "/"}, {"GET", "/b/" + id}, {"GET", "/app.js"}, {"GET", "/api/boards"},
		{"GET", "/api/b/" + id + "/board"}, {"PUT", "/api/b/" + id + "/board"}, {"POST", "/api/ids"}}
	do := func(method, path, host string) int {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader("{}"))
		req.Host = host
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	for _, rt := range routes {
		if code := do(rt[0], rt[1], "evil.example:"+port); code != 403 {
			t.Errorf("%s %s from evil.example: %d, want 403", rt[0], rt[1], code)
		}
	}
	for _, host := range []string{"127.0.0.1:" + port, "localhost:" + port} {
		for _, path := range []string{"/b/" + id, "/api/boards", "/api/b/" + id + "/board", "/app.js"} {
			if code := do("GET", path, host); code != 200 {
				t.Errorf("GET %s from %s: %d, want 200", path, host, code)
			}
		}
	}
}

func TestRegisterAfterLastLineWithoutNewline(t *testing.T) {
	a := newBoardFile(t, filepath.Join(t.TempDir(), "a"), "TODO.json", "A")
	b := newBoardFile(t, filepath.Join(t.TempDir(), "b"), "TODO.json", "B")
	registry := filepath.Join(t.TempDir(), "boards")
	os.WriteFile(registry, []byte(a), 0o644)
	if err := register(registry, b); err != nil {
		t.Fatal(err)
	}
	if l := newHub(registry, "me").list(); len(l) != 2 || l[0].ID != fileID(a) || l[1].ID != fileID(b) {
		src, _ := os.ReadFile(registry)
		t.Errorf("boards = %+v from registry %q, want A then B", l, src)
	}
}

// One poll that sees A and B change wakes A's stream for both: A's board
// and the list, neither crowding out the other.
func TestPollSendsBoardAndList(t *testing.T) {
	dir := t.TempDir()
	a := newBoardFile(t, filepath.Join(dir, "a"), "TODO.json", "A")
	b := newBoardFile(t, filepath.Join(dir, "b"), "TODO.json", "B")
	h, ts := startHub(t, a, b)
	events := listen(t, ts.URL+"/api/b/"+fileID(a)+"/events")
	nextList(t, events)
	agentAdd(t, a, "new on A")
	agentAdd(t, b, "new on B")
	h.poll()
	var gotBoard, gotList bool
	for !gotBoard || !gotList {
		e := next(t, events)
		switch e.name {
		case "":
			var st state
			json.Unmarshal([]byte(e.data), &st)
			gotBoard = st.Board != nil && strings.Contains(titles(*st.Board, 0), "new on A")
		case "boards":
			var l []listed
			json.Unmarshal([]byte(e.data), &l)
			gotList = len(l) == 2 && l[1].Version == stamp(b)
		}
	}
}

func TestClaim(t *testing.T) {
	path := filepath.Join(t.TempDir(), "TODO.json")
	hubLike := func(status int, body string) int {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			io.WriteString(w, body)
		}))
		t.Cleanup(ts.Close)
		_, p, _ := net.SplitHostPort(ts.Listener.Addr().String())
		var n int
		fmt.Sscan(p, &n)
		return n
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	free := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	for _, c := range []struct {
		name  string
		port  int
		serve bool
		url   string
	}{
		{"free port", free, true, fmt.Sprintf("http://127.0.0.1:%d/b/%s", free, fileID(path))},
		{"a hub", hubLike(200, "[]"), false, "/b/" + fileID(path)},
		{"a 404", hubLike(404, "[]"), false, ""},
		{"not an array", hubLike(200, `{"boards": []}`), false, ""},
	} {
		ln, url, err := claim(c.port, path)
		if ln != nil {
			ln.Close()
		}
		switch {
		case c.url == "" && (err == nil || !strings.Contains(err.Error(), fmt.Sprint(c.port))):
			t.Errorf("%s: err = %v, want one naming port %d", c.name, err, c.port)
		case c.url != "" && (err != nil || (ln != nil) != c.serve || !strings.HasSuffix(url, c.url)):
			t.Errorf("%s: serve=%v url=%q err=%v, want serve=%v and %s", c.name, ln != nil, url, err, c.serve, c.url)
		}
	}
}

func TestBoardRegisteredWhileRunningIsServedAtOnce(t *testing.T) {
	a := newBoardFile(t, filepath.Join(t.TempDir(), "a"), "TODO.json", "A")
	b := newBoardFile(t, filepath.Join(t.TempDir(), "b"), "TODO.json", "B")
	h, ts := startHub(t, a)
	if err := register(h.registry, b); err != nil {
		t.Fatal(err)
	}
	var got state
	if code := getJSON(t, ts.URL+"/api/b/"+fileID(b)+"/board", &got); code != 200 || got.Board == nil || got.Board.Columns[0].Cards[0].Title != "B" {
		t.Fatalf("GET B: %d %+v, want B's board", code, got)
	}
}
