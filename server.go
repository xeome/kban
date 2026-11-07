package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

//go:embed ui
var ui embed.FS
var uiFS, _ = fs.Sub(ui, "ui")

// uiTags is each embedded file's ETag. Embedded files have no modification
// time, so without one the browser downloads mermaid.js (5 MB) on every load.
var uiTags = func() map[string]string {
	tags := map[string]string{}
	fs.WalkDir(uiFS, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(uiFS, p)
			sum := sha256.Sum256(b)
			tags[p] = `"` + hex.EncodeToString(sum[:8]) + `"`
		}
		return err
	})
	return tags
}()

// serveUI serves an embedded file, revalidated by its ETag on every load.
func serveUI(w http.ResponseWriter, r *http.Request, name string) {
	w.Header().Set("ETag", uiTags[name])
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFileFS(w, r, uiFS, name)
}

type state struct {
	Board *Board `json:"board,omitempty"`
	Error string `json:"error,omitempty"`
}

func currentUser() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return "me"
}

// fileID names a board's file the same way across kban restarts, however
// its path was spelled. A hash, because JSON mangles a path that is not
// UTF-8, and the URL names the board by it.
func fileID(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:8])
}

// handler serves the 127.0.0.1 listener; tailnet serves the tailnet
// address, where a phone answers questions but asks and acks none.
func (h *hub) handler() http.Handler { return h.mux(true) }
func (h *hub) tailnet() http.Handler { return h.mux(false) }

func (h *hub) mux(local bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", h.root)
	mux.HandleFunc("GET /b/{id}", h.on(func(w http.ResponseWriter, r *http.Request, _ *served) { serveUI(w, r, "index.html") }))
	mux.HandleFunc("GET /api/b/{id}/board", h.on(h.getBoard))
	mux.HandleFunc("PUT /api/b/{id}/board", h.on(h.putBoard))
	mux.HandleFunc("GET /api/b/{id}/events", h.on(h.events))
	mux.HandleFunc("GET /api/boards", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, h.list()) })
	mux.HandleFunc("POST /api/ids", newIDs)
	mux.HandleFunc("GET /s/{session}", func(w http.ResponseWriter, r *http.Request) { serveUI(w, r, "index.html") })
	mux.HandleFunc("GET /api/s/{session}/events", h.sessionEvents)
	mux.HandleFunc("POST /api/q/{token}/answer", h.answer)
	mux.HandleFunc("GET /api/q/{token}/file/{path}", h.image)
	ask, ack := h.ask, h.ack
	if !local {
		ask, ack = http.NotFound, http.NotFound
	}
	mux.HandleFunc("POST /api/grill/ask", ask)
	mux.HandleFunc("POST /api/q/{token}/ack", ack)
	files := http.FileServerFS(uiFS)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if tag := uiTags[strings.TrimPrefix(r.URL.Path, "/")]; tag != "" {
			w.Header().Set("ETag", tag)
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
	return localOnly(mux)
}

// localOnly answers 403 to a Host other than this listener's own address
// or localhost, with its port: on a fixed port, DNS rebinding would let any
// web page read and write the boards.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addr := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
		_, port, _ := net.SplitHostPort(addr.String())
		if r.Host != addr.String() && r.Host != "127.0.0.1:"+port && r.Host != "localhost:"+port {
			http.Error(w, "kban answers only to 127.0.0.1, localhost and its tailnet address", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *hub) root(w http.ResponseWriter, r *http.Request) {
	id := h.first()
	if id == "" {
		http.Error(w, "no boards yet: run kban <file>", http.StatusNotFound)
		return
	}
	http.Redirect(w, r, "/b/"+id, http.StatusFound)
}

func (h *hub) on(f func(http.ResponseWriter, *http.Request, *served)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bf := h.find(r.PathValue("id"))
		if bf == nil {
			http.Error(w, "no board "+r.PathValue("id")+" in "+h.registry, http.StatusNotFound)
			return
		}
		f(w, r, bf)
	}
}

func (h *hub) getBoard(w http.ResponseWriter, r *http.Request, bf *served) {
	st := bf.state()
	writeJSON(w, map[string]any{"file": filepath.Base(bf.path), "project": bf.project, "user": h.user, "board": st.Board, "error": st.Error})
}

// putBoard takes the board the client last saw and the board it has now,
// and merges against whatever is on disk. A file that does not parse is
// left alone: overwriting it would replace what the agent wrote with the
// tab's older view. X-Kban-Version is the file's version after the write, as
// /api/boards will list it, so the tab marks its own save as seen.
func (h *hub) putBoard(w http.ResponseWriter, r *http.Request, bf *served) {
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
	bf.writeMu.Lock()
	defer bf.writeMu.Unlock()
	out, err := update(bf.path, func(disk *Board) error {
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
	w.Header().Set("X-Kban-Version", stamp(bf.path))
	io.WriteString(w, out)
}

func (h *hub) events(w http.ResponseWriter, r *http.Request, bf *served) {
	s := h.subscribe(bf)
	defer h.unsubscribe(bf, s)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	// Firefox fires open on the first body bytes, not the headers, and the
	// page reloads the board on open.
	io.WriteString(w, ":\n\n")
	signal(s.list)
	signal(s.grill)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-bf.gone:
			return
		case <-s.board:
			data, _ := json.Marshal(bf.state())
			fmt.Fprintf(w, "data: %s\n\n", data)
		case <-s.list:
			data, _ := json.Marshal(h.list())
			fmt.Fprintf(w, "event: boards\ndata: %s\n\n", data)
		case <-s.grill:
			h.mu.Lock()
			data := h.grillEventLocked("")
			h.mu.Unlock()
			fmt.Fprintf(w, "event: grill\ndata: %s\n\n", data)
		}
		w.(http.Flusher).Flush()
	}
}

func (bf *served) load() (Board, error) {
	src, err := os.ReadFile(bf.path)
	if err != nil {
		return Board{}, err
	}
	return Parse(string(src))
}

func (bf *served) state() state {
	b, err := bf.load()
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
