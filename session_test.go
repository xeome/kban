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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const ackWait = 300 * time.Millisecond

var png1 = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89" +
	"\x00\x00\x00\rIDATx\x9ccc\xf8\xcf\x00\x00\x00\x02\x01\x01\x00z:\xc6\xf0\x00\x00\x00\x00IEND\xaeB`\x82")

func question(over ...any) map[string]any {
	q := map[string]any{
		"id": "D7", "task": "session store", "question": "Which store holds sessions?", "say_ok": "keep sessions in Postgres",
		"hard_to_undo": false, "today": "Sessions live in memory.", "problem": "A restart logs everyone out.",
		"options": []any{
			map[string]any{"label": "Postgres", "get": "Survives restarts.", "cost": "One table.", "undo": "Drop the table."},
			map[string]any{"label": "Redis", "get": "Faster reads.", "cost": "A new service to run.", "undo": "Remove the service."},
			map[string]any{"label": "Memory", "get": "Nothing new.", "cost": "Logout on every deploy.", "undo": "None needed."},
		},
	}
	for i := 0; i+1 < len(over); i += 2 {
		if over[i+1] == nil {
			delete(q, over[i].(string))
		} else {
			q[over[i].(string)] = over[i+1]
		}
	}
	return q
}

func hard(over ...any) map[string]any {
	return question(append([]any{"hard_to_undo", true, "say_ok", nil}, over...)...)
}

func textBlock() map[string]any { return map[string]any{"kind": "text", "text": "x"} }

type sessionHub struct {
	t        *testing.T
	h        *hub
	ts, tail *httptest.Server
	dir      string
	mu       sync.Mutex
	opened   []string
}

func startSessions(t *testing.T, paths ...string) *sessionHub {
	t.Helper()
	h, ts := startHub(t, paths...)
	t.Cleanup(ts.CloseClientConnections) // before Close, which waits for held asks
	g := &sessionHub{t: t, h: h, ts: ts, dir: t.TempDir()}
	h.ackWait = ackWait
	h.browse = func(u string) { g.mu.Lock(); g.opened = append(g.opened, u); g.mu.Unlock() }
	h.push.locked = func() bool { return false }
	h.push.topic = filepath.Join(g.dir, "no-topic")
	g.tail = httptest.NewServer(h.tailnet())
	t.Cleanup(g.tail.Close)
	return g
}

func (g *sessionHub) relay(session string) *relayProc {
	return startRelay(g.t, portOf(g.ts), session, g.dir)
}

func (g *sessionHub) tabs() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.opened...)
}

type sittingView struct {
	ID, Status, Relay string
	Answer            *answer
}

type sessionsEvent struct {
	Open     []openLine
	Sessions []struct {
		Session, Project, Task, Branch, Line string
		Time                                 int64
	}
	Session struct {
		Source    *source
		Sitting   []sittingView
		Questions []struct {
			Token, Relay string
			Question     json.RawMessage
		}
		Reports []struct {
			Time int64
			Text string
		}
	}
}

func (g *sessionHub) view(session string) sessionsEvent {
	g.t.Helper()
	r, err := http.Get(g.ts.URL + "/api/s/" + url.PathEscape(session) + "/events")
	if err != nil {
		g.t.Fatal(err)
	}
	defer r.Body.Close()
	name := ""
	for sc := bufio.NewScanner(r.Body); sc.Scan(); {
		if v, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
			name = v
		} else if v, ok := strings.CutPrefix(sc.Text(), "data: "); ok && name == "sessions" {
			var out sessionsEvent
			json.Unmarshal([]byte(v), &out)
			return out
		}
	}
	g.t.Fatal("the session stream ended before its sessions event")
	return sessionsEvent{}
}

func (g *sessionHub) last(session, id, status string) sittingView {
	g.t.Helper()
	return g.lastWithin(session, id, status, 2*time.Second)
}

// An ask travels through the relay, so it lands a moment after the call.
func (g *sessionHub) token(session, id string) string {
	g.t.Helper()
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		for _, q := range g.view(session).Session.Questions {
			var head struct{ ID string }
			json.Unmarshal(q.Question, &head)
			if head.ID == id {
				return q.Token
			}
		}
	}
	g.t.Fatalf("no open question %s in session %s", id, session)
	return ""
}

func post(t *testing.T, u, ctype string, body []byte) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", u, bytes.NewReader(body))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	c := http.Client{Timeout: 3 * time.Second} // an ask that was taken is held: no answer
	r, err := c.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer r.Body.Close()
	out, _ := io.ReadAll(r.Body)
	return r.StatusCode, string(out)
}

func (g *sessionHub) answer(token string, body any) (int, string) {
	g.t.Helper()
	data, ok := body.(string)
	if !ok {
		b, _ := json.Marshal(body)
		data = string(b)
	}
	return post(g.t, g.ts.URL+"/api/q/"+token+"/answer", "application/json", []byte(data))
}

func TestAnswerReachesTheModelVerbatim(t *testing.T) {
	g := startSessions(t)
	r := g.relay("s")
	id := r.ask(question())
	tok := g.token("s", "D7")
	if m := r.response(id, 300*time.Millisecond); m != nil {
		t.Fatalf("the call returned before an answer: %v", m)
	}
	words := "Redis, because \"reads\" dominate\nand we run it anyway [see 1] <b>"
	if code, body := g.answer(tok, map[string]any{"kind": "option", "option": 1, "words": words}); code != 200 || !strings.Contains(body, "Sent.") {
		t.Fatalf("answer: %d %s", code, body)
	}
	a := r.answerOf(id)
	if a.ID != "D7" || a.Kind != "option" || a.Option != "B" || a.Label != "Redis" || a.Words != words {
		t.Errorf("answer = %+v", a)
	}
	if text, _ := r.tool(id); !strings.Contains(text, "<b>") {
		t.Errorf("the words reach the model escaped: %s", text)
	}
	if code, _ := g.answer(tok, map[string]any{"kind": "defer"}); code != 410 {
		t.Errorf("a second answer: %d, want 410", code)
	}
	for _, c := range []struct {
		kind, words string
	}{{"defer", "after I see the plan"}, {"text", "what does B cost per month?"}} {
		id := r.ask(question("id", c.kind))
		g.answer(g.token("s", c.kind), map[string]any{"kind": c.kind, "words": c.words})
		if a := r.answerOf(id); a.Kind != c.kind || a.Words != c.words || a.Option != nil || a.Label != nil {
			t.Errorf("%s answer = %+v", c.kind, a)
		}
	}
}

func TestAnswerRules(t *testing.T) {
	g := startSessions(t)
	r := g.relay("s")

	id := r.ask(hard())
	tok := g.token("s", "D7")
	for _, kind := range []string{"option", "ask"} {
		for _, bad := range []string{"true", "1.0", `"1"`, "null", "3", "-1"} {
			if code, _ := g.answer(tok, fmt.Sprintf(`{"kind": %q, "option": %s, "words": "w"}`, kind, bad)); code != 400 {
				t.Errorf("%s with option %s: %d, want 400", kind, bad, code)
			}
		}
	}
	for _, body := range []string{`{"kind": "text", "words": ""}`, `{"kind": "maybe"}`, `{"kind": "defer", "words": 3}`, `[`} {
		if code, _ := g.answer(tok, body); code != 400 {
			t.Errorf("%s: %d, want 400", body, code)
		}
	}
	if m := r.response(id, 300*time.Millisecond); m != nil {
		t.Fatalf("a refused answer reached the model: %v", m)
	}
	if code, _ := g.answer(tok, map[string]any{"kind": "ask", "option": 1}); code != 200 {
		t.Fatalf("a lean on a hard-to-undo question: %d", code)
	}
	if a := r.answerOf(id); a.Kind != "ask" || a.Option != "B" || a.Label != "Redis" || a.Words != "" {
		t.Errorf("ask with a lean = %+v", a)
	}

	for _, c := range []struct {
		body  map[string]any
		words string
	}{{map[string]any{"kind": "ask"}, ""}, {map[string]any{"kind": "ask", "words": "w"}, "w"}} {
		id := r.ask(question())
		g.answer(g.token("s", "D7"), c.body)
		if a := r.answerOf(id); a.Kind != "ask" || a.Option != nil || a.Label != nil || a.Words != c.words {
			t.Errorf("%v = %+v", c.body, a)
		}
	}
	id = r.ask(hard())
	if code, body := g.answer(g.token("s", "D7"), map[string]any{"kind": "option", "option": 2}); code != 200 {
		t.Fatalf("a bare pick on a hard-to-undo question: %d %s, want 200", code, body)
	}
	if a := r.answerOf(id); a.Kind != "option" || a.Option != "C" || a.Label != "Memory" || a.Words != "" {
		t.Errorf("a bare pick on a hard-to-undo question = %+v", a)
	}
}

func TestOneOpenQuestionPerRelay(t *testing.T) {
	g := startSessions(t)
	r := g.relay("s")
	first := r.ask(question("id", "D1"))
	tok := g.token("s", "D1")
	if text, isErr := r.tool(r.ask(question("id", "D2"))); !isErr || !strings.Contains(text, "D1 is still open") {
		t.Errorf("a second ask from the relay: %q, want D1 named as still open", text)
	}
	r.cancel(first)
	if e := g.last("s", "D1", "cancelled"); e.Status != "cancelled" {
		t.Fatalf("D1 after a cancel: %+v", e)
	}
	if code, _ := g.answer(tok, map[string]any{"kind": "defer"}); code != 410 {
		t.Errorf("answering a cancelled question: %d, want 410", code)
	}
	if m := r.response(first, 300*time.Millisecond); m != nil {
		t.Errorf("a cancelled call got a response: %v", m)
	}
	second := r.ask(question("id", "D2"))
	g.answer(g.token("s", "D2"), map[string]any{"kind": "defer"})
	if a := r.answerOf(second); a.ID != "D2" {
		t.Errorf("the next question after a cancel = %+v", a)
	}
}

func refused(t *testing.T, g *sessionHub, r *relayProc, q map[string]any, path string) {
	t.Helper()
	text, isErr := r.tool(r.ask(q))
	if !isErr || !strings.Contains(text, path) {
		t.Errorf("%s: %q (error %v), want an error naming it", path, text, isErr)
	}
	if open := g.view("s").Open; len(open) != 0 {
		t.Errorf("%s: a question opened: %+v", path, open)
	}
}

func accepted(t *testing.T, g *sessionHub, r *relayProc, q map[string]any) {
	t.Helper()
	id := r.ask(q)
	if m := r.response(id, 300*time.Millisecond); m != nil {
		t.Errorf("refused: %v", m)
		return
	}
	r.cancel(id)
	for end := time.Now().Add(2 * time.Second); len(g.view("s").Open) > 0 && time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
	}
}

func TestMalformedQuestionsNameTheirPath(t *testing.T) {
	g := startSessions(t)
	r := g.relay("s")
	t.Chdir(g.dir) // so the hub finds a.png, and only its being relative refuses it
	img := filepath.Join(g.dir, "a.png")
	os.WriteFile(img, png1, 0o644)
	txt := filepath.Join(g.dir, "a.txt")
	os.WriteFile(txt, []byte("not an image"), 0o644)
	opts := question()["options"].([]any)
	noCost := question("options", []any{opts[0], map[string]any{"label": "Redis", "get": "g", "undo": "u"}, opts[2]})
	three := func(cells ...any) []any { return []any{map[string]any{"label": "Latency", "cells": cells}} }
	code := func() map[string]any { return map[string]any{"kind": "code", "code": "y"} }
	for _, c := range []struct {
		q    map[string]any
		path string
	}{
		{question("options", opts[:1]), "options"},
		{noCost, "options[1].cost"},
		{question("say_ok", nil), "say_ok"},
		{hard("say_ok", "x"), "say_ok"},
		{question("hard_to_undo", "no"), "hard_to_undo"},
		{question("evidence", "ask_server.py:1"), "evidence"},
		{question("n", "2<img src=x>"), "n:"},
		{question("total", 1.5), "total:"},
		{question("diagram", "flowchart LR"), "diagram: not a field; put a diagram block in context"},
		{question("task", nil), "task"},
		{question("task", "   "), "task"},
		{question("context", []any{textBlock(), map[string]any{"kind": "chart", "data": []any{}}}), "context[1].kind"},
		{question("context", []any{map[string]any{"kind": []any{"text"}, "text": "x"}}), "context[0].kind"},
		{question("rows", []any{map[string]any{"label": "Cost", "cells": []any{"a", "b", "c"}}}), "rows[0].label"},
		{question("context", []any{textBlock(), map[string]any{"kind": "code"}}), "context[1].code"},
		{question("context", []any{map[string]any{"kind": "code", "code": "x", "foo": 1}}), "context[0].foo"},
		{question("context", []any{map[string]any{"kind": "code", "code": "x", "lang": 1}}), "context[0].lang"},
		{question("context", []any{map[string]any{"kind": "text", "text": "   "}}), "context[0].text"},
		{question("detail", []any{map[string]any{"kind": "table", "columns": []any{"a", "b"}, "rows": []any{[]any{"1"}}}}), "detail[0].rows[0]"},
		{question("detail", []any{map[string]any{"kind": "stats", "items": []any{map[string]any{"label": "x"}}}}), "detail[0].items[0].value"},
		{question("detail", []any{map[string]any{"kind": "stats", "items": []any{map[string]any{"label": "x", "value": "1", "unit": "s"}}}}), "detail[0].items[0]: label, value"},
		{question("context", []any{map[string]any{"kind": "image", "path": "a.png"}}), "context[0].path"},
		{question("context", []any{map[string]any{"kind": "image", "path": filepath.Join(g.dir, "missing.png")}}), "context[0].path"},
		{question("context", []any{map[string]any{"kind": "image", "path": txt}}), "context[0].path"},
		{question("context", "text"), "context"},
		{question("rows", three("1 ms", "2 ms")), "rows[0].cells"},
		{question("rows", three("1 ms", "  ", "3 ms")), "rows[0].cells[1]"},
		{question("rows", three("1 ms", textBlock(), "3 ms")), "rows[0].cells[1]"},
		{question("rows", three(textBlock(), code(), textBlock())), "rows[0].cells[1].kind"},
		{question("rows", append(three("a", "b", "c"), three("d", "e", "f")...)), "rows[1].label"},
		{question("rows", []any{map[string]any{"label": "Undo", "cells": []any{"a", "b", "c"}}}), "rows[0].label"},
		{question("rows", []any{map[string]any{"label": "", "cells": []any{"a", "b", "c"}}}), "rows[0].label"},
		{question("rows", []any{map[string]any{"label": "L", "cells": []any{"a", "b", "c"}, "x": 1}}), "rows[0]: an object"},
	} {
		refused(t, g, r, c.q, c.path)
	}
	if text, isErr := r.tool(r.call("tools/call", map[string]any{"name": "ask", "arguments": []any{1}})); !isErr || !strings.HasPrefix(text, "arguments:") {
		t.Errorf("arguments not an object: %q", text)
	}
}

func TestEachLimitIsExact(t *testing.T) {
	g := startSessions(t)
	r := g.relay("s")
	n := func(k int, f func(i int) any) []any {
		out := []any{}
		for i := range k {
			out = append(out, f(i))
		}
		return out
	}
	row := func(i int, cell any) any {
		return map[string]any{"label": fmt.Sprintf("Row %d", i), "cells": []any{cell, cell, cell}}
	}
	table := func(cols, rows int) any {
		return map[string]any{"kind": "table", "columns": n(cols, func(i int) any { return fmt.Sprint("c", i) }),
			"rows": n(rows, func(int) any { return n(cols, func(int) any { return "1" }) })}
	}
	stats := func(k int) any {
		return map[string]any{"kind": "stats", "items": n(k, func(i int) any { return map[string]any{"label": fmt.Sprint("s", i), "value": "1"} })}
	}
	for _, c := range []struct {
		build func(k int) map[string]any
		limit int
		path  string
	}{
		{func(k int) map[string]any { return question("context", n(k, func(int) any { return textBlock() })) }, 4, "context[4]"},
		{func(k int) map[string]any { return question("detail", n(k, func(int) any { return textBlock() })) }, 6, "detail[6]"},
		{func(k int) map[string]any { return question("rows", n(k, func(i int) any { return row(i, "x") })) }, 4, "rows[4]"},
		{func(k int) map[string]any {
			return question("rows", n(k, func(i int) any { return row(i, textBlock()) }))
		}, 2, "rows[2]"},
		{func(k int) map[string]any { return question("context", []any{table(k, 1)}) }, 8, "context[0].columns"},
		{func(k int) map[string]any { return question("context", []any{table(2, k)}) }, 30, "context[0].rows[30]"},
		{func(k int) map[string]any { return question("context", []any{stats(k)}) }, 4, "context[0].items[4]"},
		{func(k int) map[string]any { return question("task", strings.Repeat("é", k)) }, 60, "task: 60 characters"},
	} {
		accepted(t, g, r, c.build(c.limit))
		refused(t, g, r, c.build(c.limit+1), c.path)
	}
}

func TestImagesAreServedByBlockPathWhileOpen(t *testing.T) {
	g := startSessions(t)
	r := g.relay("s")
	png := filepath.Join(g.dir, "shot.png")
	os.WriteFile(png, png1, 0o644)
	svg := filepath.Join(g.dir, "mock.svg")
	svgSrc := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/x")</script></svg>`)
	os.WriteFile(svg, svgSrc, 0o644)
	img := func(p string) any { return map[string]any{"kind": "image", "path": p} }
	id := r.ask(question("context", []any{textBlock(), img(png)},
		"rows", []any{map[string]any{"label": "Layout", "cells": []any{img(svg), img(svg), img(svg)}}}))
	tok := g.token("s", "D7")
	file := func(base, tok, path string) (*http.Response, []byte) {
		resp, err := http.Get(base + "/api/q/" + tok + "/file/" + url.PathEscape(path))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp, body
	}
	if resp, body := file(g.ts.URL, tok, "context[1]"); resp.StatusCode != 200 || !bytes.Equal(body, png1) || resp.Header.Get("Content-Type") != "image/png" {
		t.Errorf("context[1]: %s %s", resp.Status, resp.Header.Get("Content-Type"))
	}
	resp, body := file(g.tail.URL, tok, "rows[0].cells[2]")
	if resp.StatusCode != 200 || !bytes.Equal(body, svgSrc) || resp.Header.Get("Content-Security-Policy") != "sandbox" ||
		resp.Header.Get("X-Content-Type-Options") != "nosniff" || resp.Header.Get("Content-Type") != "image/svg+xml" {
		t.Errorf("an svg on the tailnet: %s %v", resp.Status, resp.Header)
	}
	for _, p := range []string{"context[0]", "context[2]", "context[01]", "context.1", "context[-1]", "context[1]/../x", png, "rows[0].cells[3]"} {
		if resp, _ := file(g.ts.URL, tok, p); resp.StatusCode == 200 {
			t.Errorf("%s was served", p)
		}
	}
	if resp, _ := file(g.ts.URL, "not-the-token", "context[1]"); resp.StatusCode == 200 {
		t.Error("served under another token")
	}
	os.Remove(png)
	if resp, _ := file(g.ts.URL, tok, "context[1]"); resp.StatusCode != 404 {
		t.Errorf("a file removed after the ask: %s", resp.Status)
	}
	g.answer(tok, map[string]any{"kind": "defer"})
	r.answerOf(id)
	if resp, _ := file(g.ts.URL, tok, "rows[0].cells[0]"); resp.StatusCode == 200 {
		t.Error("served after the question closed")
	}
}

func TestATabOpensUnlessADesktopTabAcks(t *testing.T) {
	for _, c := range []struct {
		name   string
		ack    func(g *sessionHub, tok string) int
		opened int
	}{
		{"no tab", func(*sessionHub, string) int { return 204 }, 1},
		{"a desktop tab", func(g *sessionHub, tok string) int {
			code, _ := post(t, g.ts.URL+"/api/q/"+tok+"/ack", "application/json", nil)
			return code
		}, 0},
		{"a phone", func(g *sessionHub, tok string) int {
			code, _ := post(t, g.tail.URL+"/api/q/"+tok+"/ack", "application/json", nil)
			return code
		}, 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := startSessions(t)
			r := g.relay("sess-1")
			r.ask(question())
			if code := c.ack(g, g.token("sess-1", "D7")); code != 204 && !(c.name == "a phone" && code == 404) {
				t.Errorf("ack: %d", code)
			}
			time.Sleep(ackWait + 400*time.Millisecond)
			tabs := g.tabs()
			if len(tabs) != c.opened {
				t.Fatalf("xdg-open got %v, want %d tabs", tabs, c.opened)
			}
			if c.opened == 1 && tabs[0] != g.ts.URL+"/s/sess-1" {
				t.Errorf("opened %s, want the session page on 127.0.0.1", tabs[0])
			}
		})
	}
}

func TestThePhoneAnswersOnTheTailnetButNeverAsks(t *testing.T) {
	g := startSessions(t)
	r := g.relay("s")
	id := r.ask(question())
	tok := g.token("s", "D7")
	resp, err := http.Get(g.tail.URL + "/s/s")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("the session page on the tailnet: %v %v", err, resp)
	}
	resp.Body.Close()
	body, _ := json.Marshal(map[string]any{"kind": "option", "option": 1, "words": ""})
	if code, out := post(t, g.tail.URL+"/api/q/"+tok+"/answer", "application/json", body); code != 200 {
		t.Fatalf("answer on the tailnet: %d %s", code, out)
	}
	if a := r.answerOf(id); a.Label != "Redis" {
		t.Errorf("answer = %+v", a)
	}
	ask, _ := json.Marshal(map[string]any{"relay": "r", "session": "s", "cwd": g.dir, "args": question()})
	if code, _ := post(t, g.tail.URL+"/api/ask", "application/json", ask); code != 404 {
		t.Errorf("an ask on the tailnet listener: %d, want 404", code)
	}
	rep, _ := json.Marshal(map[string]any{"relay": "r", "session": "s", "cwd": g.dir, "text": "from the tailnet"})
	if code, _ := post(t, g.tail.URL+"/api/report", "application/json", rep); code != 404 {
		t.Errorf("a report on the tailnet listener: %d, want 404", code)
	}
	if reps := g.view("s").Session.Reports; len(reps) != 0 {
		t.Errorf("the tailnet's report landed: %+v", reps)
	}
}

// A cross-site page can send a simple POST, with any of these types or none, without asking first.
func TestAskAndReportTakeOnlyJSON(t *testing.T) {
	g := startSessions(t)
	body, _ := json.Marshal(map[string]any{"relay": "r", "session": "s", "cwd": g.dir, "args": question(), "text": "a report"})
	for _, route := range []string{"ask", "report"} {
		for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"} {
			if code, _ := post(t, g.ts.URL+"/api/"+route, ct, body); code != http.StatusUnsupportedMediaType {
				t.Errorf("%s sent as %q: %d, want 415", route, ct, code)
			}
		}
	}
	if v := g.view("s"); len(v.Open) != 0 || len(v.Session.Reports) != 0 {
		t.Errorf("a question opened or a report landed: %+v %+v", v.Open, v.Session.Reports)
	}
}

func TestAReportReturnsAtOnceAndReachesItsSessionOnly(t *testing.T) {
	board := newBoardFile(t, t.TempDir(), "TODO.json", "A")
	g := startSessions(t, board)
	events := listen(t, g.ts.URL+"/api/b/"+fileID(board)+"/events")
	r := g.relay("s")
	text := "## Done\n\n```mermaid\nflowchart LR\n  A --> B\n```"
	start := time.Now()
	url, isErr := r.tool(r.report(text))
	if isErr || url != g.ts.URL+"/s/s" || time.Since(start) > 2*time.Second {
		t.Fatalf("report: %q (error %v) after %s, want the page URL at once", url, isErr, time.Since(start))
	}
	page := g.view("s").Session
	reps := page.Reports
	if len(reps) != 1 || reps[0].Text != text || reps[0].Time == 0 {
		t.Fatalf("the session's reports = %+v, want the text", reps)
	}
	if page.Source == nil || page.Source.Project != filepath.Base(g.dir) {
		t.Errorf("a session that only reported: source %+v, want its project", page.Source)
	}
	for {
		e := next(t, events)
		var v sessionsEvent
		json.Unmarshal([]byte(e.data), &v)
		if e.name != "sessions" || len(v.Sessions) == 0 {
			continue
		}
		if strings.Contains(e.data, "flowchart") || len(v.Sessions) != 1 || v.Sessions[0].Session != "s" ||
			v.Sessions[0].Project != filepath.Base(g.dir) || v.Sessions[0].Time != reps[0].Time {
			t.Errorf("the board stream's sessions event: %s, want session s, its project and time, and no text", e.data)
		}
		if strings.Contains(e.data, `"line"`) {
			t.Errorf("the board stream's sessions event: %s, want no report line", e.data)
		}
		break
	}

	g.report("t", "from t")
	if reps := g.view("t").Session.Reports; len(reps) != 1 || reps[0].Text != "from t" {
		t.Errorf("session t's page: %+v, want its own report alone", reps)
	}
	if lines := g.view("s").Sessions; len(lines) != 2 || lines[0].Session != "t" || lines[1].Session != "s" {
		t.Errorf("reporting sessions = %+v, want t, then s", lines)
	}
	if msg, isErr := r.tool(r.report(strings.Repeat("x", reportText+1))); !isErr || !strings.Contains(msg, "64 KiB") {
		t.Errorf("a report past 64 KiB: %.80q (error %v), want the tool error naming the cap", msg, isErr)
	}
	if reps := g.view("s").Session.Reports; len(reps) != 1 {
		t.Errorf("the session's reports = %d, want the long one refused", len(reps))
	}
}

func (g *sessionHub) report(session, text string) {
	g.t.Helper()
	g.reportFrom(session, g.dir, text)
}

func (g *sessionHub) reportFrom(session, cwd, text string) {
	g.t.Helper()
	body, _ := json.Marshal(map[string]any{"relay": "r", "session": session, "cwd": cwd, "text": text})
	if code, out := post(g.t, g.ts.URL+"/api/report", "application/json", body); code != 200 {
		g.t.Fatalf("report %q: %d %s", text, code, out)
	}
}

// Each row fails a different wrong rule. A session keeps its newest 50; once
// the hub holds 500, a session below 50 takes the oldest report of the
// stalest other session that holds one.
func TestEachSessionKeepsItsNewest50Reports(t *testing.T) {
	type run struct {
		session string
		n       int
	}
	others := func(last int) []run {
		rs := []run{}
		for i := 1; i <= 9; i++ {
			rs = append(rs, run{fmt.Sprint("s", i), 50})
		}
		return append(rs, run{"s10", last})
	}
	for _, c := range []struct {
		name  string
		asker string
		runs  []run
		want  map[string]int
	}{
		{"a busy session drops only its own oldest", "", []run{{"a", 1}, {"b", 51}}, map[string]int{"a": 1, "b": 50}},
		{"at 500 the stalest session loses, not the oldest report or the largest session", "",
			append([]run{{"a", 1}, {"s1", 49}, {"a", 1}}, others(50)[1:]...), map[string]int{"a": 2, "s1": 48}},
		{"a session at 50 with the hub at 500 takes from no one", "", append(others(50), run{"s1", 1}), map[string]int{"s1": 50}},
		{"the stalest other, never the reporting session itself", "", append(append([]run{{"a", 1}}, others(49)...), run{"a", 1}),
			map[string]int{"a": 2, "s1": 49}},
		{"a session with no report is never the stalest", "z", append(append([]run{{"x", 1}}, others(49)...), run{"n", 2}),
			map[string]int{"x": 0, "z": 0, "n": 2, "s1": 49}},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := startSessions(t)
			if c.asker != "" {
				g.relay(c.asker).ask(question())
				g.token(c.asker, "D7")
			}
			sent := map[string][]string{}
			seq := 0
			for _, r := range c.runs {
				for range r.n {
					g.report(r.session, fmt.Sprint(seq))
					sent[r.session] = append(sent[r.session], fmt.Sprint(seq))
					seq++
				}
			}
			if c.asker != "" {
				sent[c.asker] = nil
			}
			times := make([]int64, seq)
			held := 0
			listed := map[string]bool{}
			for _, l := range g.view(c.runs[0].session).Sessions {
				listed[l.Session] = true
			}
			for s, texts := range sent {
				want, named := c.want[s]
				if !named {
					want = len(texts)
				}
				reps := g.view(s).Session.Reports
				got := []string{}
				for _, rep := range slices.Backward(reps) {
					got = append(got, rep.Text)
					var at int
					fmt.Sscan(rep.Text, &at)
					times[at] = rep.Time
				}
				if !slices.Equal(got, texts[len(texts)-want:]) {
					t.Errorf("session %s kept %v, want its newest %d of %v", s, got, want, texts)
				}
				held += len(reps)
				if listed[s] != (s == c.asker || want > 0) {
					t.Errorf("session %s listed: %v, want only a session with a task or a report", s, listed[s])
				}
			}
			if held > 500 {
				t.Errorf("the hub holds %d reports, want at most 500", held)
			}
			last := int64(0)
			for at, tm := range times {
				if tm != 0 && tm <= last {
					t.Errorf("report %d has time %d after %d: times must rise across the hub", at, tm, last)
				}
				last = max(last, tm)
			}
		})
	}
}

func TestASessionsLineIsItsNewestReportsFirstLine(t *testing.T) {
	g := startSessions(t)
	g.relay("q").ask(question())
	g.token("q", "D7")
	line := func(want string) {
		t.Helper()
		v := g.view("r")
		for _, l := range v.Sessions {
			if l.Session == "q" && (l.Task != "session store" || l.Line != "" || l.Time != 0 || l.Project != filepath.Base(g.dir)) {
				t.Errorf("the asking session's line: %+v, want its task and project, no time and no line", l)
			}
			if l.Session == "r" && (l.Line != want || len(v.Session.Reports) == 0 || l.Time != v.Session.Reports[0].Time) {
				t.Errorf("the reporting session's line: %+v, want %q at its newest report's time", l, want)
			}
		}
		if len(v.Sessions) != 3 {
			t.Errorf("sessions: %+v, want q, r and o", v.Sessions)
		}
	}
	other := filepath.Join(t.TempDir(), "elsewhere")
	os.Mkdir(other, 0o755)
	g.reportFrom("o", other, "# Other")
	g.report("r", "\n\n## "+strings.Repeat("€", 100)+"\nsecond")
	line(strings.Repeat("€", 66)) // 198 bytes: the cut stays on a rune boundary
	g.report("r", "\n# Title\nsecond")
	line("Title")
	g.report("r", "#123 fixed")
	line("#123 fixed") // not a heading: no space after the #
	for _, c := range []struct{ page, session, want string }{{"r", "o", ""}, {"o", "o", "Other"}, {"o", "r", ""}} {
		for _, l := range g.view(c.page).Sessions {
			if l.Session == c.session && l.Line != c.want {
				t.Errorf("session %s's line on %s's page: %q, want %q: a page lists only its own project's lines", c.session, c.page, l.Line, c.want)
			}
		}
	}
}

func TestAReportRefreshesTheSessionsBranch(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "projx")
	if out, err := exec.Command("git", "init", "-q", "-b", "one", repo).CombinedOutput(); err != nil {
		t.Skip("no git:", err, string(out))
	}
	g := startSessions(t)
	r := startRelay(t, portOf(g.ts), "s", repo)
	id := r.ask(question("task", "sidebar redesign"))
	g.answer(g.token("s", "D7"), map[string]any{"kind": "defer"})
	r.answerOf(id)
	g.reportFrom("s", repo, "on one")
	if out, err := exec.Command("git", "-C", repo, "switch", "-q", "-c", "two").CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	g.reportFrom("s", repo, "on two")
	if src := g.view("s").Session.Source; src == nil || src.Branch != "two" || src.Task != "sidebar redesign" {
		t.Errorf("source after a switch and a report: %+v, want branch two and the ask's task", src)
	}
}

func TestTheSessionNamesItsProjectBranchAndTask(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "projx")
	os.MkdirAll(filepath.Join(repo, "sub"), 0o755)
	if out, err := exec.Command("git", "init", "-q", "-b", "feat-y", repo).CombinedOutput(); err != nil {
		t.Skip("no git:", err, string(out))
	}
	plain := filepath.Join(root, "plain-dir")
	os.MkdirAll(plain, 0o755)
	worktree := filepath.Join(root, "wt-1")
	os.MkdirAll(worktree, 0o755)
	os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: "+filepath.Join(repo, ".git", "worktrees", "wt-1")+"\n"), 0o644)
	g := startSessions(t)
	for _, c := range []struct{ cwd, project, branch string }{
		{filepath.Join(repo, "sub"), "projx", "feat-y"}, {plain, "plain-dir", ""}, {worktree, "projx", ""},
	} {
		session := filepath.Base(c.cwd)
		r := startRelay(t, portOf(g.ts), session, c.cwd)
		id := r.ask(question("task", "sidebar redesign"))
		g.answer(g.token(session, "D7"), map[string]any{"kind": "defer"})
		r.answerOf(id)
		src := g.view(session).Session.Source
		if src == nil || src.Project != c.project || src.Branch != c.branch || src.Task != "sidebar redesign" || !strings.HasSuffix(src.Path, filepath.Base(c.cwd)) {
			t.Errorf("source from %s = %+v, want %s on %q, and the task outliving its question", c.cwd, src, c.project, c.branch)
		}
	}
}

// Fails on a hub with one question slot for everyone.
func TestTwoSessionsAskAtOnce(t *testing.T) {
	g := startSessions(t)
	a, b := g.relay("sa"), g.relay("sb")
	ida, idb := a.ask(question("id", "A1")), b.ask(question("id", "B1"))
	g.token("sa", "A1")
	tokB := g.token("sb", "B1")
	a.stop()
	if e := g.last("sa", "A1", "cancelled"); e.Status != "cancelled" {
		t.Fatalf("A1 once its relay stopped: %+v", e)
	}
	if e := g.last("sb", "B1", "open"); e.Status != "open" {
		t.Fatalf("B1 once A's relay stopped: %+v, want still open", e)
	}
	g.answer(tokB, map[string]any{"kind": "option", "option": 2, "words": "b"})
	if ans := b.answerOf(idb); ans.ID != "B1" || ans.Option != "C" {
		t.Errorf("B got %+v", ans)
	}
	if m := a.response(ida, 200*time.Millisecond); m != nil {
		t.Errorf("A got %v", m)
	}
}

func TestOneSessionTwoRelays(t *testing.T) {
	g := startSessions(t)
	a, b := g.relay("s"), g.relay("s")
	ida, idb := a.ask(question("id", "A1")), b.ask(question("id", "B1"))
	tokA, tokB := g.token("s", "A1"), g.token("s", "B1")
	if qs := g.view("s").Session.Questions; len(qs) != 2 || qs[0].Relay == qs[1].Relay {
		t.Fatalf("the session page shows %+v, want both relays' questions", qs)
	}
	g.answer(tokB, map[string]any{"kind": "defer", "words": "to b"})
	g.answer(tokA, map[string]any{"kind": "defer", "words": "to a"})
	if x, y := a.answerOf(ida), b.answerOf(idb); x.Words != "to a" || y.Words != "to b" {
		t.Errorf("A got %+v, B got %+v", x, y)
	}
}

func TestKillingOneRelayOfASessionLeavesTheOther(t *testing.T) {
	g := startSessions(t)
	a, b := g.relay("s"), g.relay("s")
	a.ask(question("id", "A1"))
	idb := b.ask(question("id", "B1"))
	g.token("s", "A1")
	tokB := g.token("s", "B1")
	a.kill()
	if e := g.last("s", "A1", "cancelled"); e.Status != "cancelled" {
		t.Fatalf("A1 once its relay died: %+v", e)
	}
	if qs := g.view("s").Session.Questions; len(qs) != 1 || qs[0].Token != tokB {
		t.Fatalf("the session shows %+v, want B1 alone", qs)
	}
	g.answer(tokB, map[string]any{"kind": "defer", "words": "b"})
	if ans := b.answerOf(idb); ans.ID != "B1" || ans.Words != "b" {
		t.Errorf("B got %+v", ans)
	}
}

// A relay that hangs up cancels its question, whatever byte the body ends
// on. A body read by a json.Decoder stops before the trailing newline, so
// the server would never notice the hang-up.
func TestAHangUpCancelsTheQuestion(t *testing.T) {
	g := startSessions(t)
	// Its own server: one that missed a hang-up holds the ask for good, and closing it would wait for that.
	srv := httptest.NewServer(g.h.handler())
	t.Cleanup(func() {
		if !t.Failed() {
			srv.Close()
		}
	})
	for _, size := range []int{513, 1025, 2049} {
		relay := fmt.Sprint("raw-", size)
		build := func(pad int) []byte {
			opt := map[string]any{"label": "l", "get": "g", "cost": "c", "undo": "u"}
			b, _ := json.Marshal(map[string]any{"relay": relay, "session": "s", "cwd": "/", "args": map[string]any{
				"id": relay, "task": "t", "question": "q", "say_ok": "s", "hard_to_undo": false, "today": "t",
				"problem": strings.Repeat("p", pad), "options": []any{opt, opt}}})
			return append(b, '\n')
		}
		body := build(1)
		body = build(1 + size - len(body))
		if len(body) != size {
			t.Fatalf("body is %d bytes, want %d", len(body), size)
		}
		conn, err := net.Dial("tcp", srv.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(conn, "POST /api/ask HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
			srv.Listener.Addr(), len(body), body)
		g.token("s", relay)
		conn.Close()
		if e := g.lastWithin("s", relay, "cancelled", time.Second); e.Status != "cancelled" {
			t.Errorf("a %d-byte ask that hung up: %+v, want cancelled within 1s", size, e)
		}
	}
}

func (g *sessionHub) lastWithin(session, id, status string, d time.Duration) sittingView {
	var e sittingView
	for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		for _, s := range g.view(session).Session.Sitting {
			if s.ID == id {
				e = s
			}
		}
		if e.Status == status {
			break
		}
	}
	return e
}
