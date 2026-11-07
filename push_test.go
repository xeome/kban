package main

import (
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

func ntfy(t *testing.T, g *grillHub) <-chan pushed {
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
	os.WriteFile(g.h.push.topic, []byte("grill-test-topic\n"), 0o644)
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
	g := startGrill(t)
	got := ntfy(t, g)
	r := g.relay("sess-1")
	r.ask(question())
	g.token("sess-1", "D7")
	g.h.push.tick(time.Now())
	none(t, got, "before the delay")
	g.h.push.tick(time.Now().Add(time.Hour + time.Second))
	p := one(t, got, "after the delay")
	if p.path != "/grill-test-topic" || p.click != "http://100.64.0.1:4177/s/sess-1" ||
		p.body != "session store\nD7: Which store holds sessions?" {
		t.Errorf("pushed %+v", p)
	}
	g.h.push.tick(time.Now().Add(3 * time.Hour))
	none(t, got, "a second time")
}

func TestNoPushForAQuestionClosedInTimeOrWithNowhereToSend(t *testing.T) {
	later := func(g *grillHub) { g.h.push.tick(time.Now().Add(2 * time.Hour)) }
	for _, c := range []struct {
		name string
		do   func(g *grillHub, r *relayProc, id int)
	}{
		{"answered", func(g *grillHub, r *relayProc, id int) {
			g.answer(g.token("s", "D7"), map[string]any{"kind": "defer"})
			r.answerOf(id)
		}},
		{"cancelled", func(g *grillHub, r *relayProc, id int) { r.cancel(id); g.last("s", "D7", "cancelled") }},
		{"no topic file", func(g *grillHub, _ *relayProc, _ int) { os.Remove(g.h.push.topic) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := startGrill(t)
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
		g := startGrill(t)
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

func TestALockedScreenPushesAtAskTime(t *testing.T) {
	g := startGrill(t)
	got := ntfy(t, g)
	g.h.push.locked = func() bool { return true }
	r := g.relay("s")
	r.ask(question())
	g.token("s", "D7")
	g.h.push.tick(time.Now())
	one(t, got, "at ask time")
	g.h.push.tick(time.Now().Add(2 * time.Hour))
	none(t, got, "a second push")
}

func TestASilentNtfyNeverStallsThePollLoop(t *testing.T) {
	path := newBoardFile(t, t.TempDir(), "TODO.json", "A")
	h, ts := startHub(t, path)
	g := &grillHub{t: t, h: h, ts: ts, dir: t.TempDir()}
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
