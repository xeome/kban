package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
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

func reviewFile(t *testing.T, dir string, cards ...string) string {
	t.Helper()
	b := Board{Instructions: "test"}
	for _, col := range []string{"Todo", "Approve", "Review", "Reviewed", "Building"} {
		b.Columns = append(b.Columns, Column{Title: col, Cards: []Card{}})
	}
	for _, id := range cards {
		b.Columns[0].Cards = append(b.Columns[0].Cards, Card{ID: id, Title: "card " + id})
	}
	path := filepath.Join(dir, "TODO.json")
	put(t, path, Write(b))
	return path
}

// A move keeps the file's size, and mtime ticks coarser than these edits
// land, so each write sets a later mtime of its own for the poll to see.
var mtime = time.Now()

func put(t *testing.T, path, src string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	mtime = mtime.Add(time.Second)
	os.Chtimes(path, mtime, mtime)
}

func edit(t *testing.T, path string, f func(*Board)) {
	t.Helper()
	if _, err := update(path, func(b *Board) error { f(b); return nil }); err != nil {
		t.Fatal(err)
	}
	mtime = mtime.Add(time.Second)
	os.Chtimes(path, mtime, mtime)
}

func mv(id, to string) func(*Board) {
	return func(b *Board) {
		card := Card{ID: id, Title: "card " + id}
		for c := range b.Columns {
			cards := b.Columns[c].Cards
			if i := slices.IndexFunc(cards, func(x Card) bool { return x.ID == id }); i >= 0 {
				card = cards[i]
				b.Columns[c].Cards = slices.Delete(cards, i, i+1)
			}
		}
		for c := range b.Columns {
			if b.Columns[c].Title == to {
				b.Columns[c].Cards = append(b.Columns[c].Cards, card)
			}
		}
	}
}

func rename(from, to string) func(*Board) {
	return func(b *Board) {
		for c := range b.Columns {
			if b.Columns[c].Title == from {
				b.Columns[c].Title = to
			}
		}
	}
}

func cardLink(path, card string) string {
	return "http://100.64.0.1:4177/b/" + fileID(path) + "#card=" + card
}

func sweep(p *push) (early, late []string) {
	from := time.Now()
	for d := time.Duration(0); d <= 2*p.delay; d += p.delay / 20 {
		for _, it := range p.tick(from.Add(d)) {
			if d < p.delay {
				early = append(early, it.link)
			} else {
				late = append(late, it.link)
			}
		}
	}
	slices.Sort(late)
	return early, late
}

func TestACardEnteringApproveOrReviewPushesItsLinkOnce(t *testing.T) {
	a := reviewFile(t, t.TempDir(), "c1", "c2")
	g := startGrill(t, a)
	got := ntfy(t, g)
	g.h.poll()
	edit(t, a, mv("c1", "Approve"))
	edit(t, a, mv("c2", "Review"))
	g.h.poll()
	want := []string{cardLink(a, "c1"), cardLink(a, "c2")}
	if early, late := sweep(g.h.push); len(early) != 0 || !slices.Equal(late, want) {
		t.Fatalf("took %v before the delay and %v by twice it, want none then %v", early, late, want)
	}
	var clicks []string
	for range 2 {
		p := one(t, got, "ntfy")
		if !strings.Contains(p.body, "card c") {
			t.Errorf("pushed %q, want the card's title in it", p.body)
		}
		clicks = append(clicks, p.click)
	}
	if slices.Sort(clicks); !slices.Equal(clicks, want) {
		t.Errorf("ntfy got Click %v, want %v", clicks, want)
	}
	none(t, got, "a third post")
	if early, late := sweep(g.h.push); len(early)+len(late) != 0 {
		t.Errorf("a second sweep took %v %v", early, late)
	}
}

func TestOnlyACardStillWaitingAtTheDelayPushes(t *testing.T) {
	for _, c := range []struct {
		name  string
		steps []func(*Board)
		want  string
	}{
		{"into Reviewed", []func(*Board){mv("c1", "Reviewed")}, ""},
		{"moved out", []func(*Board){mv("c1", "Review"), mv("c1", "Todo")}, ""},
		{"moved into Building first", []func(*Board){mv("c1", "Approve"), mv("c1", "Building")}, ""},
		{"deleted", []func(*Board){mv("c1", "Review"), mv("c1", "")}, ""},
		{"its column renamed", []func(*Board){mv("c1", "Review"), rename("Review", "Reviewing")}, ""},
		{"added straight into Review", []func(*Board){mv("new", "Review")}, "Review"},
		{"moved from Approve into Review", []func(*Board){mv("c1", "Approve"), mv("c1", "Review")}, "Review"},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := reviewFile(t, t.TempDir(), "c1")
			g := startGrill(t, a)
			got := ntfy(t, g)
			g.h.poll()
			for _, s := range c.steps {
				edit(t, a, s)
				g.h.poll()
			}
			want := 0
			if c.want != "" {
				want = 1
			}
			if early, late := sweep(g.h.push); len(early) != 0 || len(late) != want {
				t.Fatalf("took %v before the delay and %v by twice it, want %d after", early, late, want)
			}
			if c.want != "" {
				if p := one(t, got, "ntfy"); !strings.HasPrefix(p.body, c.want+" · ") {
					t.Errorf("pushed %q, want it to name %s", p.body, c.want)
				}
			}
		})
	}
}

func TestWhatAHubFindsOnItsFirstReadNeverPushes(t *testing.T) {
	a := reviewFile(t, t.TempDir(), "c1")
	edit(t, a, mv("c1", "Review"))
	g := startGrill(t, a)
	ntfy(t, g)
	g.h.poll()

	b := reviewFile(t, t.TempDir(), "c1")
	edit(t, b, mv("c1", "Approve"))
	register(g.h.registry, b)
	g.h.poll()

	src, _ := os.ReadFile(a)
	put(t, a, "{")
	g.h.poll()
	put(t, a, string(src))
	g.h.poll()

	c := filepath.Join(t.TempDir(), "TODO.json")
	put(t, c, "{")
	register(g.h.registry, c)
	g.h.poll()
	put(t, c, string(src))
	g.h.poll()

	if early, late := sweep(g.h.push); len(early)+len(late) != 0 {
		t.Errorf("took %v %v, want none", early, late)
	}
}

// A tab sends seen when its stream brings the card, so the item must be
// open by then.
func TestTheItemIsOpenBeforeTheStreamHearsOfTheMove(t *testing.T) {
	a := reviewFile(t, t.TempDir(), "c1")
	g := startGrill(t, a)
	ntfy(t, g)
	g.h.poll()
	s := g.h.subscribe(g.h.find(fileID(a)))
	heard, made := false, 0
	g.h.push.locked = func() bool { heard = heard || len(s.board) > 0; made++; return false }
	edit(t, a, mv("c1", "Review"))
	g.h.poll()
	if made != 1 || heard || len(s.board) != 1 {
		t.Errorf("items made %d, the stream signalled before one: %v, after the poll: %v; want 1, false, true", made, heard, len(s.board) == 1)
	}
}

func seen(t *testing.T, base, ctype string, body any) int {
	t.Helper()
	b, _ := json.Marshal(body)
	code, _ := post(t, base+"/api/seen", ctype, b)
	return code
}

func TestSeenDropsOnlyWhatItNames(t *testing.T) {
	a := reviewFile(t, t.TempDir(), "c1", "c2")
	b := reviewFile(t, t.TempDir(), "c1")
	g := startGrill(t, a, b)
	ntfy(t, g)
	g.h.poll()
	edit(t, a, mv("c1", "Review"))
	edit(t, a, mv("c2", "Review"))
	edit(t, b, mv("c1", "Review"))
	g.h.poll()
	g.h.push.add("", "T1", "T1", "q1")
	g.h.push.add("", "T2", "T2", "q2")

	all := map[string]any{"board": fileID(a), "cards": []string{"c1", "c2"}, "tokens": []string{"T1", "T2"}}
	for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded"} {
		if code := seen(t, g.ts.URL, ct, all); code != http.StatusUnsupportedMediaType {
			t.Errorf("seen sent as %q: %d, want 415", ct, code)
		}
	}
	if code := seen(t, g.ts.URL, "application/json", map[string]any{"cards": []string{"c1"}}); code != 204 {
		t.Errorf("seen with no board: %d, want 204", code)
	}
	if code := seen(t, g.ts.URL, "application/json", map[string]any{"board": fileID(a), "cards": []string{"c1"}, "tokens": []string{"T1"}}); code != 204 {
		t.Errorf("seen: %d, want 204", code)
	}
	want := []string{"T2", cardLink(a, "c2"), cardLink(b, "c1")}
	slices.Sort(want)
	if _, late := sweep(g.h.push); !slices.Equal(late, want) {
		t.Errorf("took %v, want %v", late, want)
	}
}

// The phone's seen counts, but only a desktop tab's ack stops xdg-open.
func TestSeenFromThePhoneDropsTheQuestionButOpensATab(t *testing.T) {
	g := startGrill(t)
	ntfy(t, g)
	g.relay("s").ask(question())
	tok := g.token("s", "D7")
	if code := seen(t, g.tail.URL, "application/json", map[string]any{"tokens": []string{tok}}); code != 204 {
		t.Errorf("seen on the tailnet: %d, want 204", code)
	}
	time.Sleep(ackWait + 400*time.Millisecond)
	if tabs := g.tabs(); len(tabs) != 1 {
		t.Errorf("xdg-open got %v, want one tab", tabs)
	}
	if early, late := sweep(g.h.push); len(early)+len(late) != 0 {
		t.Errorf("took %v %v, want none", early, late)
	}
}

// The desktop tab claims to show what hyprlock hides; the phone's tab does not.
func TestALockedScreenIgnoresOnlyTheDesktopsSeen(t *testing.T) {
	a := reviewFile(t, t.TempDir(), "c1", "c2", "c3")
	g := startGrill(t, a)
	ntfy(t, g)
	g.h.poll()
	locked := false
	g.h.push.locked = func() bool { return locked }
	edit(t, a, mv("c1", "Review"))
	g.h.poll()
	locked = true
	edit(t, a, mv("c2", "Review"))
	edit(t, a, mv("c3", "Review"))
	g.h.poll()
	seen(t, g.ts.URL, "application/json", map[string]any{"board": fileID(a), "cards": []string{"c1", "c2", "c3"}})
	seen(t, g.tail.URL, "application/json", map[string]any{"board": fileID(a), "cards": []string{"c3"}})
	var now []string
	for _, it := range g.h.push.tick(time.Now()) {
		now = append(now, it.link)
	}
	if !slices.Equal(now, []string{cardLink(a, "c2")}) {
		t.Errorf("took %v at once, want only c2: made while locked, and seen by no phone", now)
	}
	if _, late := sweep(g.h.push); !slices.Equal(late, []string{cardLink(a, "c1")}) {
		t.Errorf("took %v by the delay, want the item made before the lock", late)
	}
}
