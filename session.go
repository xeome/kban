package main

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Questions: each agent session's `kban mcp` relay posts a question
// and holds the request until a tab answers it. The held request is the
// question's life: when it ends, by a terminal cancel or a session that
// ended, the question is cancelled.

const taskMax = 60

var (
	kindOrder  = []string{"text", "code", "diff", "table", "stats", "diagram", "image"}
	blockKinds = map[string]struct{ req, opt []string }{
		"text": {[]string{"text"}, nil}, "code": {[]string{"code"}, []string{"lang"}}, "diff": {[]string{"diff"}, nil},
		"table": {[]string{"columns", "rows"}, nil}, "stats": {[]string{"items"}, nil},
		"diagram": {[]string{"mermaid"}, nil}, "image": {[]string{"path"}, nil},
	}
	imageTypes = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
		".webp": "image/webp", ".svg": "image/svg+xml"}
	questionFields = []string{"id", "task", "n", "total", "question", "say_ok", "hard_to_undo", "today", "problem",
		"context", "options", "rows", "evidence", "detail"}
	optionRows  = []string{"get", "cost", "undo"}
	fixedLabels = []string{"what you get", "what it costs", "undo", "get", "cost", "costs"}
	limits      = map[string]int{"context": 4, "detail": 6, "rows": 4, "block_rows": 2, "columns": 8, "table_rows": 30, "stats": 4}
)

type session struct {
	source  *source
	sitting []*asked
	reports []report
}

// A report is keyed by its time in Unix ms, unique across the hub.
type report struct {
	Time int64  `json:"time"`
	Text string `json:"text"`
}

// Each session keeps its newest reportMax reports, and the hub at most
// reportHub, in memory: a restart loses them, as it loses the sitting. A
// session page's event carries that session's reports, marshalled under
// h.mu, so a report's text is capped.
const (
	reportMax  = 50
	reportHub  = 500
	reportText = 64 << 10
)

type source struct {
	Project string `json:"project"`
	Path    string `json:"path"`
	Branch  string `json:"branch"`
	Task    string `json:"task"`
}

// asked is a question in its session's sitting. Closed, it keeps only what
// the sitting shows: id, question, relay, status and answer.
type asked struct {
	id, token, relay, session string
	question                  any
	raw                       json.RawMessage // as asked, for the page
	q                         map[string]any
	status                    string // open, answered, cancelled
	answer                    *answer
	files                     map[string]string // image block path -> file
	acked                     bool
	done                      chan []byte
}

// h.questions holds open questions only. Call with h.mu held.
func (h *hub) closeLocked(e *asked, status string) {
	e.status = status
	e.raw, e.q, e.files = nil, nil, nil
	delete(h.questions, e.token)
	h.sessionsChangedLocked()
}

type answer struct {
	ID     string `json:"id"`
	Kind   any    `json:"kind"`
	Option any    `json:"option"`
	Label  any    `json:"label"`
	Words  string `json:"words"`
}

func token() string { return rand.Text()[:16] }

func nonempty(x any) bool { s, ok := x.(string); return ok && strings.TrimSpace(s) != "" }

func integer(x any) (int64, bool) {
	n, ok := x.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}

// Image paths are collected into files, so they are checked where they are served.
func badBlock(b any, at string, files map[string]string) string {
	m, ok := b.(map[string]any)
	if !ok {
		return at + ": a block, an object with a kind"
	}
	kind, _ := m["kind"].(string)
	spec, ok := blockKinds[kind]
	if !ok {
		return at + ".kind: one of " + strings.Join(kindOrder, ", ")
	}
	for _, f := range slices.Sorted(maps.Keys(m)) {
		if f != "kind" && f != "title" && !slices.Contains(spec.req, f) && !slices.Contains(spec.opt, f) {
			return fmt.Sprintf("%s.%s: not a field of a %s block", at, f, kind)
		}
	}
	for _, f := range append([]string{"title"}, spec.opt...) {
		if v, ok := m[f]; ok {
			if _, ok := v.(string); !ok {
				return at + "." + f + ": a string"
			}
		}
	}
	switch kind {
	case "text", "code", "diff", "diagram":
		if f := spec.req[0]; !nonempty(m[f]) {
			return at + "." + f + ": required, a non-empty string"
		}
	case "table":
		cols, ok := m["columns"].([]any)
		if !ok || len(cols) < 1 || len(cols) > limits["columns"] || !all(cols, nonempty) {
			return fmt.Sprintf("%s.columns: 1 to %d non-empty strings", at, limits["columns"])
		}
		rows, ok := m["rows"].([]any)
		if !ok || len(rows) == 0 {
			return at + ".rows: required, a list of rows"
		}
		for i, r := range rows {
			if i == limits["table_rows"] {
				return fmt.Sprintf("%s.rows[%d]: at most %d rows", at, i, limits["table_rows"])
			}
			if cells, ok := r.([]any); !ok || len(cells) != len(cols) || !all(cells, func(c any) bool { _, ok := c.(string); return ok }) {
				return fmt.Sprintf("%s.rows[%d]: %d strings, one per column", at, i, len(cols))
			}
		}
	case "stats":
		items, ok := m["items"].([]any)
		if !ok || len(items) == 0 {
			return fmt.Sprintf("%s.items: required, 1 to %d items", at, limits["stats"])
		}
		for i, it := range items {
			if i == limits["stats"] {
				return fmt.Sprintf("%s.items[%d]: at most %d items", at, i, limits["stats"])
			}
			im, ok := it.(map[string]any)
			for _, f := range []string{"label", "value"} {
				if !ok || !nonempty(im[f]) {
					return fmt.Sprintf("%s.items[%d].%s: required, a non-empty string", at, i, f)
				}
			}
			_, noteOK := im["note"].(string)
			if _, has := im["note"]; has && !noteOK || slices.ContainsFunc(slices.Sorted(maps.Keys(im)), func(f string) bool { return f != "label" && f != "value" && f != "note" }) {
				return fmt.Sprintf("%s.items[%d]: label, value and an optional note, all strings", at, i)
			}
		}
	case "image":
		p, _ := m["path"].(string)
		fi, err := os.Stat(p)
		if !filepath.IsAbs(p) || imageTypes[strings.ToLower(filepath.Ext(p))] == "" || err != nil || !fi.Mode().IsRegular() {
			return at + ".path: an absolute path to an existing png, jpg, webp or svg file"
		}
		files[at] = p
	}
	return ""
}

func all(xs []any, f func(any) bool) bool {
	for _, x := range xs {
		if !f(x) {
			return false
		}
	}
	return true
}

// invalid is the first malformed field of a question, named by its path
// the way the schema names it, or "".
func invalid(x any, files map[string]string) string {
	q, ok := x.(map[string]any)
	if !ok {
		return "arguments: an object with the question's fields"
	}
	for _, f := range slices.Sorted(maps.Keys(q)) {
		if !slices.Contains(questionFields, f) {
			if f == "diagram" {
				return f + ": not a field; put a diagram block in context"
			}
			return f + ": not a field"
		}
	}
	for _, f := range []string{"id", "task", "question", "today", "problem"} {
		if !nonempty(q[f]) {
			return f + ": required, a non-empty string"
		}
	}
	if utf8.RuneCountInString(q["task"].(string)) > taskMax {
		return fmt.Sprintf("task: %d characters at most, a few words naming the work", taskMax)
	}
	hard, ok := q["hard_to_undo"].(bool)
	if !ok {
		return "hard_to_undo: required, true or false"
	}
	if _, has := q["say_ok"]; hard && has {
		return "say_ok: leave it out on a hard-to-undo question"
	}
	if !hard && !nonempty(q["say_ok"]) {
		return "say_ok: required unless hard_to_undo"
	}
	opts, ok := q["options"].([]any)
	if !ok || len(opts) < 2 || len(opts) > 4 {
		got := "none"
		if ok {
			got = fmt.Sprint(len(opts))
		}
		return "options: needs 2 to 4, got " + got
	}
	for i, o := range opts {
		om, ok := o.(map[string]any)
		for _, f := range append([]string{"label"}, optionRows...) {
			if !ok || !nonempty(om[f]) {
				return fmt.Sprintf("options[%d].%s: required, a non-empty string", i, f)
			}
		}
	}
	for _, f := range []string{"n", "total"} {
		if v, has := q[f]; has {
			if n, ok := integer(v); !ok || n < 1 {
				return f + ": a positive integer"
			}
		}
	}
	if v, has := q["evidence"]; has {
		if ev, ok := v.([]any); !ok || !all(ev, func(e any) bool { _, ok := e.(string); return ok }) {
			return "evidence: a list of strings"
		}
	}
	for _, f := range []string{"context", "detail"} {
		v, has := q[f]
		if !has {
			continue
		}
		blocks, ok := v.([]any)
		if !ok {
			return f + ": a list of blocks"
		}
		for i, b := range blocks {
			if i == limits[f] {
				return fmt.Sprintf("%s[%d]: at most %d blocks", f, i, limits[f])
			}
			if p := badBlock(b, fmt.Sprintf("%s[%d]", f, i), files); p != "" {
				return p
			}
		}
	}
	v, has := q["rows"]
	if !has {
		return ""
	}
	rows, ok := v.([]any)
	if !ok {
		return "rows: a list of {label, cells}"
	}
	labels, blockRows := []string{}, 0
	for i, r := range rows {
		at := fmt.Sprintf("rows[%d]", i)
		if i == limits["rows"] {
			return fmt.Sprintf("%s: at most %d rows", at, limits["rows"])
		}
		rm, ok := r.(map[string]any)
		if !ok || !slices.Equal(slices.Sorted(maps.Keys(rm)), []string{"cells", "label"}) {
			return at + ": an object with label and cells"
		}
		label, _ := rm["label"].(string)
		key := strings.ToLower(strings.TrimSpace(label))
		if !nonempty(rm["label"]) || slices.Contains(fixedLabels, key) || slices.Contains(labels, key) {
			return at + ".label: a non-empty label, unique, and not one of get, cost or undo's"
		}
		labels = append(labels, key)
		cells, ok := rm["cells"].([]any)
		if !ok || len(cells) != len(opts) {
			return fmt.Sprintf("%s.cells: one cell per option, %d", at, len(opts))
		}
		if _, ok := cells[0].(map[string]any); ok {
			if blockRows++; blockRows > limits["block_rows"] {
				return fmt.Sprintf("%s: at most %d rows of blocks", at, limits["block_rows"])
			}
		}
		_, strings0 := cells[0].(string)
		for j, c := range cells {
			if s, ok := c.(string); ok != strings0 {
				return fmt.Sprintf("%s.cells[%d]: all strings or all blocks, like cells[0]", at, j)
			} else if ok {
				if strings.TrimSpace(s) == "" {
					return fmt.Sprintf("%s.cells[%d]: a non-empty string", at, j)
				}
				continue
			}
			if p := badBlock(c, fmt.Sprintf("%s.cells[%d]", at, j), files); p != "" {
				return p
			}
			if k, k0 := c.(map[string]any)["kind"], cells[0].(map[string]any)["kind"]; k != k0 {
				return fmt.Sprintf("%s.cells[%d].kind: %s, like cells[0]", at, j, k0)
			}
		}
	}
	return ""
}

// A worktree's .git is a file naming its repository's: gitdir: <repo>/.git/worktrees/<id>.
func projectOf(dir string) string {
	for d := dir; ; d = filepath.Dir(d) {
		git := filepath.Join(d, ".git")
		if fi, err := os.Stat(git); err == nil {
			src := []byte{}
			if !fi.IsDir() {
				src, _ = os.ReadFile(git)
			}
			if gitdir, ok := strings.CutPrefix(strings.TrimSpace(string(src)), "gitdir: "); ok {
				if !filepath.IsAbs(gitdir) {
					gitdir = filepath.Join(d, gitdir)
				}
				if repo, _, ok := strings.Cut(filepath.ToSlash(gitdir), "/.git/worktrees/"); ok {
					return filepath.Base(repo)
				}
			}
			return filepath.Base(d)
		}
		if filepath.Dir(d) == d {
			return filepath.Base(dir)
		}
	}
}

// where is read at each ask: branches move.
func where(cwd string) source {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "git", "-C", cwd, "branch", "--show-current").Output()
	path := cwd
	if home, err := os.UserHomeDir(); err == nil && (cwd == home || strings.HasPrefix(cwd, home+string(filepath.Separator))) {
		path = "~" + cwd[len(home):]
	}
	return source{Project: projectOf(cwd), Path: path, Branch: strings.TrimSpace(string(out))}
}

func jsonOnly(r *http.Request) bool {
	t, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && t == "application/json"
}

func (h *hub) ask(w http.ResponseWriter, r *http.Request) {
	// A cross-site page can POST text/plain or a form here without asking first; JSON it cannot.
	if !jsonOnly(r) {
		http.Error(w, "Content-Type: application/json", http.StatusUnsupportedMediaType)
		return
	}
	// Read whole: net/http notices a relay that hung up only once the body reached EOF.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	var req struct {
		Relay, Session, Cwd string
		Args                json.RawMessage
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "body: "+err.Error(), 400)
		return
	}
	if req.Relay == "" || req.Session == "" {
		http.Error(w, "relay and session: required", 400)
		return
	}
	var args any
	dec := json.NewDecoder(bytes.NewReader(req.Args))
	dec.UseNumber()
	dec.Decode(&args)
	files := map[string]string{}
	if p := invalid(args, files); p != "" {
		http.Error(w, p, 400)
		return
	}
	q := args.(map[string]any)
	e := &asked{id: q["id"].(string), token: token(), relay: req.Relay, session: req.Session, question: q["question"], raw: req.Args, q: q,
		status: "open", files: files, done: make(chan []byte, 1)}

	// Held in h.questions, the relay's slot is taken; unpublished, no page shows it yet.
	h.mu.Lock()
	for _, o := range h.questions {
		if o.relay == e.relay {
			h.mu.Unlock()
			http.Error(w, o.id+" is still open. End your turn; its answer arrives as a task notification. "+
				"TaskStop it only after the user answered or switched to the terminal.", http.StatusConflict)
			return
		}
	}
	h.questions[e.token] = e
	tail := h.tail
	h.mu.Unlock()

	src := where(req.Cwd)
	src.Task = q["task"].(string)
	page := "/s/" + url.PathEscape(e.session)
	if tail != "" { // before it is published, so an answer or cancel at once drops it
		h.push.add(e.token, tail+page, fmt.Sprintf("%s\n%s: %s", src.Task, e.id, q["question"]))
	}
	h.mu.Lock()
	s := h.sessions[e.session]
	if s == nil {
		s = &session{}
		h.sessions[e.session] = s
	}
	s.source = &src
	s.sitting = append(s.sitting, e)
	h.sessionsChangedLocked()
	h.mu.Unlock()
	local := r.Context().Value(http.LocalAddrContextKey).(net.Addr).String()
	ack := time.AfterFunc(h.ackWait, func() {
		h.mu.Lock()
		lost := e.status == "open" && !e.acked
		h.mu.Unlock()
		if lost {
			h.browse("http://" + local + page)
		}
	})
	defer ack.Stop()

	select {
	case res := <-e.done:
		w.Header().Set("Content-Type", "application/json")
		w.Write(res)
	case <-r.Context().Done():
		h.mu.Lock()
		if e.status == "open" {
			h.closeLocked(e, "cancelled")
		}
		h.mu.Unlock()
		h.push.drop(e.token)
	}
}

func (h *hub) report(w http.ResponseWriter, r *http.Request) {
	if !jsonOnly(r) { // as ask
		http.Error(w, "Content-Type: application/json", http.StatusUnsupportedMediaType)
		return
	}
	var req struct{ Session, Cwd, Text string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		http.Error(w, "body: "+err.Error(), 400)
		return
	}
	if req.Session == "" || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "session and text: required", 400)
		return
	}
	if len(req.Text) > reportText {
		http.Error(w, fmt.Sprintf("text: %d KiB, more than the %d KiB a report holds", len(req.Text)>>10, reportText>>10), 400)
		return
	}
	src := where(req.Cwd)
	h.mu.Lock()
	s := h.sessions[req.Session]
	if s == nil {
		s = &session{}
		h.sessions[req.Session] = s
	}
	if s.source != nil { // an ask's source names its task, so it stays
		src.Task = s.source.Task
	}
	s.source = &src
	// The hub's newest report is never dropped, so times rise across the hub from it.
	t, held, stalest := time.Now().UnixMilli(), 0, (*session)(nil)
	for _, o := range h.sessions {
		if n := len(o.reports); n > 0 {
			held += n
			t = max(t, o.reports[n-1].Time+1)
			if o != s && (stalest == nil || o.reports[n-1].Time < stalest.reports[len(stalest.reports)-1].Time) {
				stalest = o
			}
		}
	}
	// slices.Delete clears the freed slot, so the dropped text goes.
	if len(s.reports) == reportMax {
		s.reports = slices.Delete(s.reports, 0, 1)
	} else if held >= reportHub { // s holds under 50, so others hold over 450: stalest is set
		stalest.reports = slices.Delete(stalest.reports, 0, 1)
	}
	s.reports = append(s.reports, report{t, req.Text})
	h.sessionsChangedLocked()
	h.mu.Unlock()
	io.WriteString(w, "http://"+r.Context().Value(http.LocalAddrContextKey).(net.Addr).String()+"/s/"+url.PathEscape(req.Session))
}

func (h *hub) answer(w http.ResponseWriter, r *http.Request) {
	var v any
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		writeStatus(w, 400, "error", "body: JSON")
		return
	}
	body, _ := v.(map[string]any)
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.questions[r.PathValue("token")]
	if e == nil {
		writeStatus(w, http.StatusGone, "error", "This question is closed: answered, or cancelled in the terminal.")
		return
	}
	res, problem := e.decide(body)
	if problem != "" {
		writeStatus(w, 400, "error", problem)
		return
	}
	e.answer = res
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(res)
	e.done <- bytes.TrimSpace(buf.Bytes())
	h.closeLocked(e, "answered")
	h.push.drop(e.token)
	writeStatus(w, 200, "message", "Sent.")
}

func (e *asked) decide(body map[string]any) (*answer, string) {
	kind := body["kind"]
	words := ""
	if v, has := body["words"]; has {
		s, ok := v.(string)
		if !ok {
			return nil, "words: a string"
		}
		words = s
	}
	res := &answer{ID: e.id, Kind: kind, Words: words}
	_, lean := body["option"]
	switch {
	case kind == "option" || kind == "ask" && lean:
		opts := e.q["options"].([]any)
		i, ok := integer(body["option"])
		if !ok || i < 0 || int(i) >= len(opts) {
			return nil, "option: not one of the shown options"
		}
		if kind == "option" && e.q["hard_to_undo"] == true && strings.TrimSpace(words) == "" {
			return nil, "Hard to undo: add one line of why."
		}
		res.Option, res.Label = string("ABCD"[i]), opts[i].(map[string]any)["label"]
	case kind == "text":
		if strings.TrimSpace(words) == "" {
			return nil, "Write your answer."
		}
	case kind != "defer" && kind != "ask":
		return nil, "kind: option, defer, text or ask"
	}
	return res, ""
}

// ack is a desktop tab saying it shows the question, so no other opens.
func (h *hub) ack(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if e := h.questions[r.PathValue("token")]; e != nil {
		e.acked = true
	}
	h.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (h *hub) image(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	f := ""
	if e := h.questions[r.PathValue("token")]; e != nil {
		f = e.files[r.PathValue("path")]
	}
	h.mu.Unlock()
	file, err := os.Open(f)
	if f == "" || err != nil { // removed or replaced since the ask
		writeStatus(w, 404, "error", "no such image in the open question")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", imageTypes[strings.ToLower(filepath.Ext(f))])
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", time.Time{}, file)
}

func writeStatus(w http.ResponseWriter, code int, key, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{key: msg})
}

type openLine struct {
	Token    string `json:"token"`
	Session  string `json:"session"`
	Project  string `json:"project"`
	Task     string `json:"task"`
	ID       string `json:"id"`
	Question any    `json:"question"`
}

// Line goes only on a session page's stream, for its project's sessions: a
// board's stream carries no report text.
type sessionLine struct {
	Session string `json:"session"`
	Project string `json:"project"`
	Task    string `json:"task"`
	Branch  string `json:"branch"`
	Time    int64  `json:"time"`
	Line    string `json:"line,omitempty"`
}

// firstLine is a report's first non-empty line, a heading marker trimmed, cut to 200 bytes.
func firstLine(text string) string {
	for l := range strings.Lines(text) {
		l = strings.TrimSpace(l)
		if h := strings.TrimLeft(l, "#"); len(l)-len(h) <= 6 && (h == "" || h[0] == ' ' || h[0] == '\t') {
			l = strings.TrimSpace(h)
		}
		if l != "" {
			return strings.ToValidUTF8(l[:min(len(l), 200)], "") // drops a rune the cut split
		}
	}
	return ""
}

type sittingLine struct {
	ID       string  `json:"id"`
	Question any     `json:"question"`
	Status   string  `json:"status"`
	Answer   *answer `json:"answer"`
	Relay    string  `json:"relay"`
}

type shownQuestion struct {
	Token    string          `json:"token"`
	Relay    string          `json:"relay"`
	Question json.RawMessage `json:"question"`
}

func (h *hub) sessionsEventLocked(session string) []byte {
	ev := struct {
		Open     []openLine    `json:"open"`
		Sessions []sessionLine `json:"sessions"`
		Session  any           `json:"session,omitempty"`
	}{Open: []openLine{}, Sessions: []sessionLine{}}
	var page *source
	if s := h.sessions[session]; s != nil {
		page = s.source
	}
	for _, sid := range slices.Sorted(maps.Keys(h.sessions)) {
		s := h.sessions[sid]
		for _, e := range s.sitting {
			if e.status == "open" {
				ev.Open = append(ev.Open, openLine{e.token, sid, s.source.Project, e.q["task"].(string), e.id, e.q["question"]})
			}
		}
		if s.source.Task == "" && len(s.reports) == 0 { // a report-only session whose reports were all dropped
			continue
		}
		l := sessionLine{Session: sid, Project: s.source.Project, Task: s.source.Task, Branch: s.source.Branch}
		if n := len(s.reports); n > 0 {
			l.Time = s.reports[n-1].Time
			if page != nil && s.source.Project == page.Project {
				l.Line = firstLine(s.reports[n-1].Text)
			}
		}
		ev.Sessions = append(ev.Sessions, l)
	}
	slices.SortStableFunc(ev.Sessions, func(a, b sessionLine) int { return cmp.Compare(b.Time, a.Time) })
	if session != "" {
		out := struct {
			Source    *source         `json:"source"`
			Sitting   []sittingLine   `json:"sitting"`
			Questions []shownQuestion `json:"questions"`
			Reports   []report        `json:"reports"`
		}{Sitting: []sittingLine{}, Questions: []shownQuestion{}, Reports: []report{}}
		if s := h.sessions[session]; s != nil {
			out.Source = s.source
			out.Reports = append(out.Reports, s.reports...)
			slices.Reverse(out.Reports)
			for _, e := range s.sitting {
				out.Sitting = append(out.Sitting, sittingLine{e.id, e.question, e.status, e.answer, e.relay})
				if e.status == "open" {
					out.Questions = append(out.Questions, shownQuestion{e.token, e.relay, e.raw})
				}
			}
		}
		ev.Session = out
	}
	data, _ := json.Marshal(ev)
	return data
}

func (h *hub) sessionsChangedLocked() {
	for _, bf := range h.boards {
		for s := range bf.subs {
			signal(s.sessions)
		}
	}
	for s := range h.sessionSubs {
		signal(s.sessions)
	}
}

func (h *hub) sessionEvents(w http.ResponseWriter, r *http.Request) {
	session := r.PathValue("session")
	s := &stream{make(chan struct{}, 1), make(chan struct{}, 1), make(chan struct{}, 1)}
	h.mu.Lock()
	h.sessionSubs[s] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.sessionSubs, s)
		h.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, ":\n\n")
	signal(s.list)
	signal(s.sessions)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.list:
			data, _ := json.Marshal(h.list())
			fmt.Fprintf(w, "event: boards\ndata: %s\n\n", data)
		case <-s.sessions:
			h.mu.Lock()
			data := h.sessionsEventLocked(session)
			h.mu.Unlock()
			fmt.Fprintf(w, "event: sessions\ndata: %s\n\n", data)
		}
		w.(http.Flusher).Flush()
	}
}
