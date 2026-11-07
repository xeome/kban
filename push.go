package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// push sends a link to the owner's phone through ntfy.sh.
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

func newPush() *push {
	home, _ := os.UserHomeDir()
	return &push{
		items:  map[string]pushItem{},
		delay:  300 * time.Second,
		locked: func() bool { return exec.Command("pidof", "hyprlock").Run() == nil },
		topic:  filepath.Join(home, ".config", "claude-notify", "topic"),
		ntfy:   "https://ntfy.sh/",
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *push) add(key, link, text string) {
	due := time.Now().Add(p.delay)
	if p.locked() {
		due = time.Now()
	}
	p.mu.Lock()
	p.items[key] = pushItem{link, text, due}
	p.mu.Unlock()
}

func (p *push) drop(key string) {
	p.mu.Lock()
	delete(p.items, key)
	p.mu.Unlock()
}

// tick sends the items due by now, each once, each in its own request, so
// a silent ntfy never holds up the caller.
func (p *push) tick(now time.Time) {
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
		return
	}
	src, _ := os.ReadFile(p.topic)
	topic := strings.TrimSpace(string(src))
	if topic == "" {
		return
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
}
