package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func kban(t *testing.T, stdin string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errw bytes.Buffer
	code = cli(args, strings.NewReader(stdin), &out, &errw)
	return code, out.String(), errw.String()
}

func readBoard(t *testing.T, path string) Board {
	t.Helper()
	src, _ := os.ReadFile(path)
	b, err := Parse(string(src))
	if err != nil {
		t.Fatalf("%v\n%s", err, src)
	}
	return b
}

func TestCLI(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.json")
	os.WriteFile(path, []byte(Write(board(col("Todo", "a"), col("Doing")))), 0o644)

	code, id, stderr := kban(t, "", "add", "-f", path, "Doing", "New thing")
	id = strings.TrimSpace(id)
	if code != 0 {
		t.Fatalf("add exited %d: %s", code, stderr)
	}
	if c := readBoard(t, path).Columns[1].Cards; len(c) != 1 || c[0].ID != id || c[0].Title != "New thing" {
		t.Fatalf("Doing = %+v, want the new card with id %q", c, id)
	}
	if code, _, stderr := kban(t, "", "move", "-f", path, id, "Todo"); code != 0 {
		t.Fatalf("move exited %d: %s", code, stderr)
	}
	if c := readBoard(t, path).Columns[0].Cards; len(c) != 2 || c[0].ID != "a" || c[1].ID != id {
		t.Fatalf("Todo = %+v, want the moved card after a", c)
	}

	steps := [][]string{
		{"move", "-f", path, id, "Doing"},
		{"set", "-f", path, id, "title", "Renamed"},
		{"set", "-f", path, id, "notes", "-"}, // as given, but for the newline stdin ends with
		{"comment", "-f", path, "-a", "claude", id, "-"},
	}
	for _, args := range steps {
		if code, _, stderr := kban(t, "  line 1\nline 2\n", args...); code != 0 {
			t.Fatalf("%v exited %d: %s", args, code, stderr)
		}
	}
	b := readBoard(t, path)
	c := b.Columns[1].Cards
	if len(b.Columns[0].Cards) != 1 || len(c) != 1 || c[0].ID != id || c[0].Title != "Renamed" || c[0].Notes != "  line 1\nline 2" {
		t.Fatalf("board = %+v, want the card moved to Doing, renamed, with the notes from stdin", b)
	}
	m := c[0].Comments
	if _, err := time.Parse(time.RFC3339, m[0].Time); len(m) != 1 || m[0].Author != "claude" || m[0].Text != "line 1\nline 2" || err != nil {
		t.Fatalf("comments = %+v, want claude's from stdin, trimmed as the browser posts it, with an RFC 3339 time", m)
	}

	code, stdout, _ := kban(t, "", "show", "-f", path, id)
	var shown struct {
		Column string
		Card
	}
	if json.Unmarshal([]byte(stdout), &shown); code != 0 || shown.Column != "Doing" || shown.ID != id || shown.Title != "Renamed" {
		t.Fatalf("show %s = %d %s", id, code, stdout)
	}
	code, stdout, _ = kban(t, "", "show", "-f", path)
	if src, _ := os.ReadFile(path); code != 0 || stdout != string(src) {
		t.Fatalf("show = %d\n%s\nwant the file", code, stdout)
	}

	was, _ := os.ReadFile(path)
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	os.Chtimes(path, old, old)
	for _, args := range [][]string{
		{"move", "-f", path, "Renamed", "Todo"}, // a title where an id belongs
		{"move", "-f", path, id, "Nowhere"},
		{"set", "-f", path, id, "title", ""},
		{"set", "-f", path, id, "colour", "red"},
		{"comment", "-f", path, id, " "},
		{"move", "-x", "-f", path, id, "Todo"},
		{"move", "-f", path, id},
	} {
		if code, _, stderr := kban(t, "", args...); code != 1 || stderr == "" {
			t.Errorf("%v exited %d, want 1 with a message", args, code)
		}
	}
	kban(t, "", "show", "-f", path)
	if got, _ := os.ReadFile(path); !bytes.Equal(got, was) {
		t.Errorf("a refused command changed the file:\n%s", got)
	}
	if fi, _ := os.Stat(path); !fi.ModTime().Equal(old) {
		t.Errorf("a refused command or show rewrote the file: mtime %v, want %v", fi.ModTime(), old)
	}
}

func TestCLIUnreadableFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.json")
	src := "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"id\": \"x\", \"title\": \"a\"},\n      {\"title\": \"b\"}\n    ]}\n  ]\n}\n"
	os.WriteFile(path, []byte(src), 0o644)
	for _, args := range [][]string{{"move", "-f", path, "x", "T"}, {"show", "-f", path}} {
		code, _, stderr := kban(t, "", args...)
		if code != 2 || !strings.Contains(stderr, "line 5") {
			t.Errorf("%v = %d %q, want 2 and the line", args, code, stderr)
		}
	}
	if got, _ := os.ReadFile(path); string(got) != src {
		t.Errorf("file was rewritten:\n%s", got)
	}
}

func TestCLIInit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "board.json")
	code, _, stderr := kban(t, "", "init", "-f", path, "-i", "Conducted", "Todo", "Ready", "Done")
	want := Board{Instructions: "Conducted", Columns: []Column{{Title: "Todo"}, {Title: "Ready"}, {Title: "Done"}}}
	if src, _ := os.ReadFile(path); code != 0 || string(src) != Write(want) {
		t.Fatalf("init = %d %q, file:\n%s\nwant:\n%s", code, stderr, src, Write(want))
	}
	if code, _, stderr := kban(t, "", "add", "-f", path, "Ready", "First"); code != 0 {
		t.Fatalf("add on the new board exited %d: %s", code, stderr)
	}

	was, _ := os.ReadFile(path)
	if code, _, stderr := kban(t, "", "init", "-f", path, "Todo"); code != 1 || !strings.Contains(stderr, "exists") {
		t.Errorf("init on an existing board = %d %q, want 1 naming it", code, stderr)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, was) {
		t.Errorf("init overwrote a board:\n%s", got)
	}
	none := filepath.Join(dir, "none.json")
	if code, _, _ := kban(t, "", "init", "-f", none); code != 1 {
		t.Errorf("init with no column exited %d, want 1", code)
	}
	if _, err := os.Stat(none); err == nil {
		t.Errorf("init with no column created the file")
	}
}
