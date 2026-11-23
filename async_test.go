package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// cardBoard writes a board with one card into dir and returns the card's id.
func cardBoard(t *testing.T, dir, file string) string {
	t.Helper()
	id := newID()
	if err := create(filepath.Join(dir, file), Board{Columns: []Column{{Title: "Todo", Cards: []Card{{ID: id, Title: "Session store"}}}}}); err != nil {
		t.Fatal(err)
	}
	return id
}

func cardComments(t *testing.T, path, card string, want int) []Comment {
	t.Helper()
	for end := time.Now().Add(3 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		b, err := Parse(string(src))
		if err != nil {
			t.Fatal(err)
		}
		c, i, err := find(&b, card)
		if err != nil {
			t.Fatal(err)
		}
		if cs := b.Columns[c].Cards[i].Comments; len(cs) >= want || time.Now().After(end) {
			return cs
		}
	}
}

func (r *relayProc) withdraw(id string) int {
	return r.call("tools/call", map[string]any{"name": "withdraw", "arguments": map[string]any{"id": id}})
}

func commentAnswer(t *testing.T, c Comment) answer {
	t.Helper()
	_, js, _ := strings.Cut(c.Text, "```json\n")
	js, _, _ = strings.Cut(js, "\n```")
	var a answer
	if err := json.Unmarshal([]byte(js), &a); err != nil {
		t.Fatalf("comment %q holds no answer JSON: %v", c.Text, err)
	}
	return a
}

func TestAskOnACardReturnsAtOnceAndCommentsTheAnswer(t *testing.T) {
	g := startSessions(t)
	card := cardBoard(t, g.dir, "TODO.json")
	r := g.relay("s")
	// tool waits for a result; nobody answers yet, so a held ask would fail here.
	if text, isErr := r.tool(r.ask(question("card", card))); isErr || !strings.Contains(text, "pending") {
		t.Fatalf("an ask on a card: %q (error %v), want a pending result at once", text, isErr)
	}
	body := map[string]any{"kind": "option", "option": 1, "words": "keep it simple"}
	if code, _ := g.answer(g.token("s", "D7"), body); code != 200 {
		t.Fatalf("answer: %d", code)
	}
	cs := cardComments(t, filepath.Join(g.dir, "TODO.json"), card, 1)
	if len(cs) != 1 || cs[0].Author != "hub" {
		t.Fatalf("comments = %+v, want one by hub", cs)
	}
	// The same answer, asked the blocking way, is what the comment must carry.
	r2 := g.relay("s2")
	id := r2.ask(question())
	g.answer(g.token("s2", "D7"), body)
	if got, want := commentAnswer(t, cs[0]), r2.answerOf(id); got != want {
		t.Errorf("comment answer %+v, want the tool's %+v", got, want)
	}
}

func TestAskOnACardAnsweredWithAskSaysToReAsk(t *testing.T) {
	g := startSessions(t)
	card := cardBoard(t, g.dir, "TODO.json")
	r := g.relay("s")
	r.tool(r.ask(question("card", card)))
	g.answer(g.token("s", "D7"), map[string]any{"kind": "ask", "words": ""})
	cs := cardComments(t, filepath.Join(g.dir, "TODO.json"), card, 1)
	if len(cs) != 1 || !strings.HasPrefix(cs[0].Text, "D7 is not decided") || commentAnswer(t, cs[0]).Kind != "ask" {
		t.Errorf("comments = %+v, want one that opens by saying D7 is not decided and keeps the answer", cs)
	}
}

func TestAskOnACardChecksTheQuestionAndCardFirst(t *testing.T) {
	g := startSessions(t)
	card := cardBoard(t, g.dir, "TODO.json")
	r := g.relay("s")
	if text, isErr := r.tool(r.ask(question("card", "nope0000"))); !isErr || !strings.Contains(text, "nope0000") {
		t.Errorf("an unknown card: %q (error %v), want an error naming it", text, isErr)
	}
	if text, isErr := r.tool(r.ask(question("card", card, "today", nil))); !isErr || !strings.HasPrefix(text, "today:") {
		t.Errorf("a malformed question on a card: %q (error %v), want the hub's field error", text, isErr)
	}
	if text, isErr := r.tool(r.ask(question("card", card, "board", "missing.json"))); !isErr || !strings.Contains(text, "missing.json") {
		t.Errorf("a missing board: %q (error %v), want an error naming it", text, isErr)
	}
	time.Sleep(200 * time.Millisecond)
	if qs := g.view("s").Session.Questions; len(qs) != 0 {
		t.Errorf("open questions %v, want none: a refused ask opens nothing", qs)
	}
}

func TestAskOnACardIsWithdrawn(t *testing.T) {
	g := startSessions(t)
	card := cardBoard(t, g.dir, "TODO.json")
	r := g.relay("s")
	r.tool(r.ask(question("card", card)))
	g.token("s", "D7")
	if text, isErr := r.tool(r.ask(question("card", card, "id", "D8"))); !isErr || !strings.Contains(text, "D7") {
		t.Errorf("a second ask while D7 waits: %q (error %v), want an error naming D7", text, isErr)
	}
	if text, isErr := r.tool(r.withdraw("D7")); isErr {
		t.Fatalf("withdraw: %q", text)
	}
	if s := g.last("s", "D7", "cancelled"); s.Status != "cancelled" {
		t.Errorf("D7 after withdraw is %q, want cancelled on the hub", s.Status)
	}
	if text, isErr := r.tool(r.withdraw("D7")); !isErr {
		t.Errorf("withdrawing it again: %q, want an error", text)
	}
	time.Sleep(300 * time.Millisecond)
	if cs := cardComments(t, filepath.Join(g.dir, "TODO.json"), card, 0); len(cs) != 0 {
		t.Errorf("comments = %+v, want none for a withdrawn question", cs)
	}
	if text, isErr := r.tool(r.ask(question("card", card, "id", "D8"))); isErr {
		t.Errorf("an ask after the withdraw: %q", text)
	}
}

func TestAskOnACardWhenTheHubDies(t *testing.T) {
	g := startSessions(t)
	card := cardBoard(t, g.dir, "IDEAS.json")
	r := g.relay("s")
	r.tool(r.ask(question("card", card, "board", "IDEAS.json")))
	g.token("s", "D7")
	g.ts.CloseClientConnections()
	cs := cardComments(t, filepath.Join(g.dir, "IDEAS.json"), card, 1)
	if len(cs) != 1 || cs[0].Author != "hub" || !strings.Contains(cs[0].Text, "D7") || !strings.Contains(cs[0].Text, "ask again") {
		t.Errorf("comments = %+v, want one by hub saying D7 closed unanswered", cs)
	}
}

func TestAskOnACardWaitsOutAnUnreadableBoard(t *testing.T) {
	g := startSessions(t)
	card := cardBoard(t, g.dir, "TODO.json")
	path := filepath.Join(g.dir, "TODO.json")
	good, _ := os.ReadFile(path)
	r := g.relay("s")
	r.tool(r.ask(question("card", card)))
	tok := g.token("s", "D7")
	os.WriteFile(path, []byte("{not json"), 0o644)
	g.answer(tok, map[string]any{"kind": "option", "option": 1, "words": "w"})
	time.Sleep(1500 * time.Millisecond)
	os.WriteFile(path, good, 0o644)
	if cs := cardComments(t, path, card, 1); len(cs) != 1 || commentAnswer(t, cs[0]).Words != "w" {
		t.Errorf("comments = %+v, want the answer once the board reads again", cs)
	}
}

func TestOneQuestionAtATimeAcrossBothKinds(t *testing.T) {
	g := startSessions(t)
	card := cardBoard(t, g.dir, "TODO.json")
	r := g.relay("s")
	held := r.ask(question())
	g.token("s", "D7")
	if text, isErr := r.tool(r.ask(question("card", card, "id", "D8"))); !isErr || !strings.Contains(text, "D7") {
		t.Errorf("a card ask while a held ask is open: %q (error %v), want an error naming D7", text, isErr)
	}
	r.cancel(held)
	g.last("s", "D7", "cancelled")
	r.tool(r.ask(question("card", card, "id", "D9")))
	g.token("s", "D9")
	if text, isErr := r.tool(r.ask(question("id", "D10"))); !isErr || !strings.Contains(text, "withdraw") {
		t.Errorf("a held ask while D9 waits on its card: %q (error %v), want an error pointing at withdraw", text, isErr)
	}
}
