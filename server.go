package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"sync"
	"time"
)

//go:embed ui
var ui embed.FS
var uiFS, _ = fs.Sub(ui, "ui")

type server struct {
	path string
	user string     // the author of comments posted from the browser
	mu   sync.Mutex // serializes this server's own writes; update guards against everyone else's

	subMu sync.Mutex
	subs  map[chan state]struct{}
}

type state struct {
	Board *Board `json:"board,omitempty"`
	Error string `json:"error,omitempty"`
}

func newServer(path string) *server {
	name := "me"
	if u, err := user.Current(); err == nil {
		name = u.Username
	}
	return &server{path: path, user: name, subs: map[chan state]struct{}{}}
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/board", s.getBoard)
	mux.HandleFunc("PUT /api/board", s.putBoard)
	mux.HandleFunc("POST /api/ids", newIDs)
	mux.HandleFunc("GET /api/events", s.events)
	mux.Handle("GET /", http.FileServerFS(uiFS))
	return mux
}

func (s *server) getBoard(w http.ResponseWriter, r *http.Request) {
	st := s.state()
	writeJSON(w, map[string]any{"file": filepath.Base(s.path), "user": s.user, "board": st.Board, "error": st.Error})
}

// putBoard takes the board the client last saw and the board it has now,
// and merges against whatever is on disk. A file that does not parse is
// left alone: overwriting it would replace what the agent wrote with the
// tab's older view.
func (s *server) putBoard(w http.ResponseWriter, r *http.Request) {
	var req struct{ Base, Board Board }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	for _, b := range []Board{req.Base, req.Board} {
		if _, err := checkIDs(b); err != nil {
			http.Error(w, err.Error()+": reload this page", 400)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out, err := update(s.path, func(disk *Board) error {
		*disk = Merge(req.Base, req.Board, *disk)
		return nil
	})
	if errors.As(err, new(unreadable)) {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, out)
}

func (s *server) events(w http.ResponseWriter, r *http.Request) {
	ch := make(chan state, 1)
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
	// Firefox fires open on the first body bytes, not the headers, and the
	// page reloads the board on open.
	io.WriteString(w, ":\n\n")
	w.(http.Flusher).Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case st := <-ch:
			data, _ := json.Marshal(st)
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
		now := s.state()
		s.subMu.Lock()
		for ch := range s.subs {
			select {
			case ch <- now:
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
	if err != nil {
		return Board{}, err
	}
	return Parse(string(src))
}

func (s *server) state() state {
	b, err := s.load()
	if err != nil {
		return state{Error: err.Error()}
	}
	return state{Board: &b}
}

// newIDs hands the browser ids for the cards it creates, so kban is the
// only thing that makes ids.
func newIDs(w http.ResponseWriter, r *http.Request) {
	ids := make([]string, 16)
	for i := range ids {
		ids[i] = newID()
	}
	writeJSON(w, ids)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
