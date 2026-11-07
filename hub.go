package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// A hub serves every board listed in its registry: one absolute path per
// line, which `kban <file>` appends to.
type hub struct {
	registry string
	user     string // the author of comments posted from the browser

	mu       sync.Mutex // guards everything below and every board's stamp and subs
	boards   map[string]*served
	order    []string
	regStamp string
	sent     []listed // the list as the streams were last told it

	sessions  map[string]*gsession
	questions map[string]*asked    // by token
	gsubs     map[*stream]struct{} // /s/{session} pages' streams
	tail      string               // the tailnet base URL, "" when off the tailnet
	ackWait   time.Duration
	browse    func(url string)
	push      *push
}

type served struct {
	path    string
	project string
	writeMu sync.Mutex // serializes putBoard's writes; update guards against everyone else's
	stamp   string
	subs    map[*stream]struct{}
	gone    chan struct{}
	waiting map[string]string // card id to its column, Approve or Review, at the last readable poll; nil before it; poll's alone
}

// A stream's signals are latest-wins: it writes the state as it is when it
// wakes, so a signal that finds one pending loses nothing.
type stream struct{ board, list, grill chan struct{} }

type listed struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	File    string `json:"file"`
	Version string `json:"version"`
}

func newHub(registry, user string) *hub {
	h := &hub{registry: registry, user: user, boards: map[string]*served{},
		sessions: map[string]*gsession{}, questions: map[string]*asked{}, gsubs: map[*stream]struct{}{},
		ackWait: 3 * time.Second, browse: openBrowser, push: newPush()}
	h.reload()
	h.sent = h.list()
	return h
}

func registryPath() (string, error) {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "kban", "boards"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "kban", "boards"), nil
}

func register(registry, path string) error {
	src, err := os.ReadFile(registry)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if slices.Contains(strings.Split(string(src), "\n"), path) {
		return nil
	}
	if len(src) > 0 && src[len(src)-1] != '\n' { // a hand edit dropped the last newline
		path = "\n" + path
	}
	if err := os.MkdirAll(filepath.Dir(registry), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(registry, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	_, err = f.WriteString(path + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func (h *hub) reload() {
	// Stamped before the read, so a write between the two is re-read by the next poll.
	st := stamp(h.registry)
	src, _ := os.ReadFile(h.registry) // no registry is no boards
	h.mu.Lock()
	defer h.mu.Unlock()
	h.regStamp = st
	keep := map[string]bool{}
	h.order = nil
	for _, line := range strings.Split(string(src), "\n") {
		if line == "" {
			continue
		}
		id := fileID(line)
		if keep[id] {
			continue
		}
		keep[id] = true
		h.order = append(h.order, id)
		if h.boards[id] == nil {
			h.boards[id] = &served{path: line, project: projectOf(filepath.Dir(line)), stamp: stamp(line), subs: map[*stream]struct{}{}, gone: make(chan struct{})}
		}
	}
	for id, bf := range h.boards {
		if !keep[id] {
			close(bf.gone)
			delete(h.boards, id)
		}
	}
}

// find is the board registered as id, re-reading the registry once on a
// miss so a board `kban <file>` just appended is served.
func (h *hub) find(id string) *served {
	h.mu.Lock()
	bf := h.boards[id]
	h.mu.Unlock()
	if bf != nil {
		return bf
	}
	h.reload()
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.boards[id]
}

func (h *hub) first() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.order) == 0 {
		return ""
	}
	return h.order[0]
}

func (h *hub) list() []listed {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.listLocked()
}

func (h *hub) listLocked() []listed {
	out := []listed{}
	for _, id := range h.order {
		bf := h.boards[id]
		out = append(out, listed{id, bf.project, filepath.Base(bf.path), bf.stamp})
	}
	return out
}

func (h *hub) subscribe(bf *served) *stream {
	s := &stream{make(chan struct{}, 1), make(chan struct{}, 1), make(chan struct{}, 1)}
	h.mu.Lock()
	bf.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

func (h *hub) unsubscribe(bf *served, s *stream) {
	h.mu.Lock()
	delete(bf.subs, s)
	h.mu.Unlock()
}

func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default: // one is pending already, and it reads the state when it wakes
	}
}

// Our own writes count, which keeps every tab converged.
func (h *hub) poll() {
	h.mu.Lock()
	regChanged := stamp(h.registry) != h.regStamp
	h.mu.Unlock()
	if regChanged {
		h.reload()
	}
	type read struct {
		id    string
		bf    *served
		stamp string
	}
	var changed []read
	h.mu.Lock()
	for id, bf := range h.boards {
		// Stamped before the read, so a write between the two is read by the next poll.
		if st := stamp(bf.path); st != bf.stamp || bf.waiting == nil {
			changed = append(changed, read{id, bf, st})
		}
	}
	tail := h.tail
	h.mu.Unlock()
	// Outside the lock: making an item runs pidof. Before the signal: a tab
	// that shows the card says so when its stream brings it.
	for _, r := range changed {
		h.waits(r.id, r.bf, tail)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range changed {
		if r.stamp != r.bf.stamp {
			r.bf.stamp = r.stamp
			for s := range r.bf.subs {
				signal(s.board)
			}
		}
	}
	if now := h.listLocked(); !slices.Equal(now, h.sent) {
		h.sent = now
		for _, bf := range h.boards {
			for s := range bf.subs {
				signal(s.list)
			}
		}
		for s := range h.gsubs {
			signal(s.list)
		}
	}
}

// The first readable poll only records what waits: a hub starting, or a board
// registered, pushes nothing old.
func (h *hub) waits(id string, bf *served, tail string) {
	b, err := bf.load()
	if err != nil {
		return
	}
	now := map[string]string{}
	for _, col := range b.Columns {
		if col.Title == "Approve" || col.Title == "Review" {
			for _, c := range col.Cards {
				now[c.ID] = col.Title
			}
		}
	}
	// Drops first: an item is the card's alone, so a drop after the add would close the new one.
	for c, col := range bf.waiting {
		if now[c] != col {
			h.push.drop(id, c)
		}
	}
	for _, col := range b.Columns {
		for _, c := range col.Cards {
			if bf.waiting != nil && now[c.ID] != "" && bf.waiting[c.ID] != now[c.ID] && tail != "" {
				h.push.add(id, c.ID, tail+"/b/"+id+"#card="+url.PathEscape(c.ID), fmt.Sprintf("%s · %s\n%s", col.Title, bf.project, c.Title))
			}
		}
	}
	bf.waiting = now
}

func (h *hub) watch() {
	for now := range time.Tick(500 * time.Millisecond) {
		h.poll()
		h.push.tick(now)
	}
}

func stamp(path string) string {
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fmt.Sprint(fi.ModTime().UnixNano(), fi.Size())
}
