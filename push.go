package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// push sends a link to the owner's phone through ntfy.sh, one per question
// that waits on them.
type push struct {
	mu     sync.Mutex
	items  map[string]pushItem
	delay  time.Duration
	locked func() bool
	topic  string
	ntfy   string
	client *http.Client
}

type pushItem struct {
	link, text string
	due        time.Time
}

// KBAN_PUSH_DELAY and KBAN_NTFY let web/e2e drive the real binary.
func newPush() *push {
	home, _ := os.UserHomeDir()
	p := &push{
		items:  map[string]pushItem{},
		delay:  300 * time.Second,
		locked: func() bool { return exec.Command("pidof", "hyprlock").Run() == nil },
		topic:  filepath.Join(home, ".config", "claude-notify", "topic"),
		ntfy:   "https://ntfy.sh/",
		client: &http.Client{Timeout: 10 * time.Second},
	}
	if d, err := time.ParseDuration(os.Getenv("KBAN_PUSH_DELAY")); err == nil {
		p.delay = d
	}
	if u := os.Getenv("KBAN_NTFY"); u != "" {
		p.ntfy = u
	}
	return p
}

func (p *push) add(token, link, text string) {
	due := time.Now().Add(p.delay)
	if p.locked() {
		due = time.Now()
	}
	p.mu.Lock()
	p.items[token] = pushItem{link, text, due}
	p.mu.Unlock()
}

func (p *push) drop(token string) {
	p.mu.Lock()
	delete(p.items, token)
	p.mu.Unlock()
}

// While hyprlock runs, a desktop tab (local) claims to show what the lock
// hides, so only the phone's seen counts.
func (p *push) seen(tokens []string, local bool) {
	p.mu.Lock()
	open := slices.ContainsFunc(tokens, func(t string) bool { _, ok := p.items[t]; return ok })
	p.mu.Unlock()
	if !open || local && p.locked() {
		return
	}
	p.mu.Lock()
	for _, t := range tokens {
		delete(p.items, t)
	}
	p.mu.Unlock()
}

// tick takes the items due by now and sends each once, in its own request,
// so a silent ntfy never holds up the caller.
func (p *push) tick(now time.Time) []pushItem {
	var due []pushItem
	p.mu.Lock()
	for k, it := range p.items {
		if !it.due.After(now) {
			due = append(due, it)
			delete(p.items, k)
		}
	}
	p.mu.Unlock()
	if len(due) == 0 {
		return nil
	}
	src, _ := os.ReadFile(p.topic)
	topic := strings.TrimSpace(string(src))
	if topic == "" {
		return due
	}
	for _, it := range due {
		go func() {
			req, err := http.NewRequest("POST", p.ntfy+topic, strings.NewReader(it.text))
			if err != nil {
				return
			}
			req.Header.Set("Click", it.link)
			if r, err := p.client.Do(req); err == nil {
				r.Body.Close()
			}
		}()
	}
	return due
}
