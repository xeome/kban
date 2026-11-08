package main

import (
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

type pushed struct{ path, click, body string }

func ntfy(t *testing.T, g *sessionHub) <-chan pushed {
	t.Helper()
	got := make(chan pushed, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got <- pushed{r.URL.Path, r.Header.Get("Click"), string(body)}
	}))
	t.Cleanup(srv.Close)
	g.h.push.ntfy = srv.URL + "/"
	g.h.push.delay = time.Hour
	g.h.push.topic = filepath.Join(g.dir, "topic")
	os.WriteFile(g.h.push.topic, []byte("test-topic\n"), 0o644)
	g.h.mu.Lock()
	g.h.tail = "http://100.64.0.1:4177"
	g.h.mu.Unlock()
	return got
}

func none(t *testing.T, got <-chan pushed, why string) {
	t.Helper()
	select {
	case p := <-got:
		t.Errorf("%s: pushed %+v", why, p)
	case <-time.After(300 * time.Millisecond):
	}
}

func one(t *testing.T, got <-chan pushed, why string) pushed {
	t.Helper()
	select {
	case p := <-got:
		return p
	case <-time.After(3 * time.Second):
		t.Fatalf("%s: nothing pushed", why)
		return pushed{}
	}
}

func TestAnUnansweredQuestionPushesItsTailnetLinkOnce(t *testing.T) {
	g := startSessions(t)
	got := ntfy(t, g)
	r := g.relay("sess-1")
	r.ask(question())
	g.token("sess-1", "D7")
	g.h.push.tick(time.Now())
	none(t, got, "before the delay")
	g.h.push.tick(time.Now().Add(time.Hour + time.Second))
	p := one(t, got, "after the delay")
	if p.path != "/test-topic" || p.click != "http://100.64.0.1:4177/s/sess-1" ||
		p.body != "session store\nD7: Which store holds sessions?" {
		t.Errorf("pushed %+v", p)
	}
	g.h.push.tick(time.Now().Add(3 * time.Hour))
	none(t, got, "a second time")
}

func TestNoPushForAQuestionClosedInTimeOrWithNowhereToSend(t *testing.T) {
	later := func(g *sessionHub) { g.h.push.tick(time.Now().Add(2 * time.Hour)) }
	for _, c := range []struct {
		name string
		do   func(g *sessionHub, r *relayProc, id int)
	}{
		{"answered", func(g *sessionHub, r *relayProc, id int) {
			g.answer(g.token("s", "D7"), map[string]any{"kind": "defer"})
			r.answerOf(id)
		}},
		{"cancelled", func(g *sessionHub, r *relayProc, id int) { r.cancel(id); g.last("s", "D7", "cancelled") }},
		{"no topic file", func(g *sessionHub, _ *relayProc, _ int) { os.Remove(g.h.push.topic) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := startSessions(t)
			got := ntfy(t, g)
			r := g.relay("s")
			id := r.ask(question())
			g.token("s", "D7")
			c.do(g, r, id)
			later(g)
			none(t, got, c.name)
		})
	}
	t.Run("off the tailnet", func(t *testing.T) {
		g := startSessions(t)
		got := ntfy(t, g)
		g.h.tail = ""
		g.h.push.locked = func() bool { return true }
		r := g.relay("s")
		r.ask(question())
		g.token("s", "D7")
		later(g)
		none(t, got, "off the tailnet")
	})
}

func TestASilentNtfyNeverStallsThePollLoop(t *testing.T) {
	path := newBoardFile(t, t.TempDir(), "TODO.json", "A")
	h, ts := startHub(t, path)
	g := &sessionHub{t: t, h: h, ts: ts, dir: t.TempDir()}
	h.ackWait = time.Hour
	held, ended := make(chan struct{}, 1), make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body) // the server sees a hang-up only once the body is read
		held <- struct{}{}
		<-r.Context().Done()
		ended <- struct{}{}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(srv.CloseClientConnections)
	h.push.ntfy = srv.URL + "/"
	h.push.topic = filepath.Join(g.dir, "topic")
	os.WriteFile(h.push.topic, []byte("t"), 0o644)
	h.push.locked = func() bool { return true }
	h.push.client.Timeout = 1500 * time.Millisecond
	h.tail = "http://100.64.0.1:4177"
	go h.watch()

	events := listen(t, ts.URL+"/api/b/"+fileID(path)+"/events")
	g.relay("s").ask(question())
	select {
	case <-held:
	case <-time.After(3 * time.Second):
		t.Fatal("the push never reached ntfy")
	}
	agentAdd(t, path, "while ntfy holds")
	for deadline := time.After(time.Second); ; {
		select {
		case e := <-events:
			if e.name == "" && strings.Contains(e.data, "while ntfy holds") {
				goto seen
			}
		case <-deadline:
			t.Fatal("a board change did not reach the stream within 1s while ntfy held a request")
		}
	}
seen:
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Error("the held push request never timed out")
	}
}

func seen(t *testing.T, base, ctype string, body any) int {
	t.Helper()
	b, _ := json.Marshal(body)
	code, _ := post(t, base+"/api/seen", ctype, b)
	return code
}

func TestSeenDropsOnlyWhatItNames(t *testing.T) {
	g := startSessions(t)
	got := ntfy(t, g)
	g.h.push.add("T1", "T1", "q1")
	g.h.push.add("T2", "T2", "q2")

	for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded"} {
		if code := seen(t, g.ts.URL, ct, map[string]any{"tokens": []string{"T1", "T2"}}); code != http.StatusUnsupportedMediaType {
			t.Errorf("seen sent as %q: %d, want 415", ct, code)
		}
	}
	if code := seen(t, g.ts.URL, "application/json", map[string]any{"tokens": []string{"T1"}}); code != 204 {
		t.Errorf("seen: %d, want 204", code)
	}
	g.h.push.tick(time.Now().Add(2 * time.Hour))
	if p := one(t, got, "T2, which seen did not name"); p.click != "T2" {
		t.Errorf("pushed %+v, want T2", p)
	}
	none(t, got, "T1, which seen named")
}

// The phone's seen counts, but only a desktop tab's ack stops xdg-open.
func TestSeenFromThePhoneDropsTheQuestionButOpensATab(t *testing.T) {
	g := startSessions(t)
	got := ntfy(t, g)
	g.relay("s").ask(question())
	tok := g.token("s", "D7")
	if code := seen(t, g.tail.URL, "application/json", map[string]any{"tokens": []string{tok}}); code != 204 {
		t.Errorf("seen on the tailnet: %d, want 204", code)
	}
	time.Sleep(ackWait + 400*time.Millisecond)
	if tabs := g.tabs(); len(tabs) != 1 {
		t.Errorf("xdg-open got %v, want one tab", tabs)
	}
	g.h.push.tick(time.Now().Add(2 * time.Hour))
	none(t, got, "a question the phone saw")
}

// The desktop tab claims to show what hyprlock hides; the phone's tab does not.
func TestALockedScreenIgnoresOnlyTheDesktopsSeen(t *testing.T) {
	g := startSessions(t)
	got := ntfy(t, g)
	locked := false
	g.h.push.locked = func() bool { return locked }
	g.h.push.add("T1", "T1", "q1")
	locked = true
	g.h.push.add("T2", "T2", "q2")
	g.h.push.add("T3", "T3", "q3")
	seen(t, g.ts.URL, "application/json", map[string]any{"tokens": []string{"T1", "T2", "T3"}})
	seen(t, g.tail.URL, "application/json", map[string]any{"tokens": []string{"T3"}})
	g.h.push.tick(time.Now())
	if p := one(t, got, "T2 at once"); p.click != "T2" {
		t.Errorf("pushed %+v at once, want only T2: made while locked, and seen by no phone", p)
	}
	none(t, got, "a second push at once")
	g.h.push.tick(time.Now().Add(2 * time.Hour))
	if p := one(t, got, "T1 by the delay"); p.click != "T1" {
		t.Errorf("pushed %+v by the delay, want the item made before the lock", p)
	}
	none(t, got, "a second push by the delay")
}
