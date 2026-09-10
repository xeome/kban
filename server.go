package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed ui
var ui embed.FS
var uiFS, _ = fs.Sub(ui, "ui")

type server struct {
	path string
	mu   sync.Mutex // serializes read-merge-write on the file

	subMu sync.Mutex
	subs  map[chan Board]struct{}
}

func newServer(path string) *server {
	return &server{path: path, subs: map[chan Board]struct{}{}}
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/board", s.getBoard)
	mux.HandleFunc("PUT /api/board", s.putBoard)
	mux.HandleFunc("GET /api/events", s.events)
	mux.Handle("GET /", http.FileServerFS(uiFS))
	return mux
}

func (s *server) getBoard(w http.ResponseWriter, r *http.Request) {
	b, err := s.load()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"file": filepath.Base(s.path), "board": b})
}

// putBoard takes the board the client last saw and the board it has now,
// merges against whatever is on disk, and returns the canonical result.
func (s *server) putBoard(w http.ResponseWriter, r *http.Request) {
	var req struct{ Base, Board Board }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	disk, err := s.load()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	merged := Parse(Write(Merge(req.Base, clean(req.Board), disk)))
	if err := s.store(merged); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, merged)
}

func (s *server) events(w http.ResponseWriter, r *http.Request) {
	ch := make(chan Board, 1)
	s.subMu.Lock()
	s.subs[ch] = struct{}{}
	s.subMu.Unlock()
	defer func() {
		s.subMu.Lock()
		delete(s.subs, ch)
		s.subMu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	for {
		select {
		case <-r.Context().Done():
			return
		case b := <-ch:
			data, _ := json.Marshal(b)
			fmt.Fprintf(w, "data: %s\n\n", data)
			w.(http.Flusher).Flush()
		}
	}
}

// watch polls the file and pushes it to every open tab when it changes,
// including after our own writes, which keeps all tabs converged.
func (s *server) watch() {
	last := s.stamp()
	for range time.Tick(500 * time.Millisecond) {
		st := s.stamp()
		if st == last {
			continue
		}
		last = st
		b, err := s.load()
		if err != nil {
			log.Println(err)
			continue
		}
		s.subMu.Lock()
		for ch := range s.subs {
			select {
			case ch <- b:
			default: // tab is behind; it will get the next one
			}
		}
		s.subMu.Unlock()
	}
}

func (s *server) stamp() string {
	fi, err := os.Stat(s.path)
	if err != nil {
		return ""
	}
	return fmt.Sprint(fi.ModTime().UnixNano(), fi.Size())
}

func (s *server) load() (Board, error) {
	src, err := os.ReadFile(s.path)
	return Parse(string(src)), err
}

func (s *server) store(b Board) error {
	tmp := s.path + ".kban~"
	if err := os.WriteFile(tmp, []byte(Write(b)), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// clean strips what the file format cannot hold: newlines in titles and
// trailing whitespace. Everything else is the user's to keep.
func clean(b Board) Board {
	for i := range b.Columns {
		c := &b.Columns[i]
		c.Title = oneLine(c.Title)
		for j := range c.Cards {
			card := &c.Cards[j]
			card.Title = oneLine(card.Title)
			lines := strings.Split(strings.ReplaceAll(card.Body, "\r\n", "\n"), "\n")
			for k := range lines {
				lines[k] = strings.TrimRight(lines[k], " \t")
			}
			card.Body = strings.Trim(strings.Join(lines, "\n"), "\n")
		}
	}
	return b
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
