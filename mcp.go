package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed ask.json
var askSchema json.RawMessage

const askDescription = "Put one grill-me decision to the user in the session's browser tab and wait for the answer. Returns JSON {id, kind, option, label, words}: kind is option, defer, text (an answer in the user's own words, no option picked) or ask (the user wants more before deciding: re-ask the same id with this tool; option and label, when set, are a lean, not a decision). Calls longer than 2 minutes move to a background task: end your turn, the answer arrives as a task notification. With card (and board, default TODO.json), it returns {id, status: pending} at once instead, and the answer lands as a comment by hub on that card, so a board watch delivers it: end your turn. One such question waits at a time; withdraw closes it."

var reportSchema = json.RawMessage(`{"type":"object","properties":{"text":{"type":"string","description":"The report, in Markdown. A mermaid fence draws as a diagram."}},"required":["text"]}`)

const reportDescription = "Show a report to the user on this session's page in the kban hub, rendered as Markdown with ```mermaid fences drawn as diagrams. Returns the page's URL at once."

var withdrawSchema = json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"The id of the question asked on a card."}},"required":["id"]}`)

const withdrawDescription = "Close the question asked on a card that is still waiting, for example when the user answered in the terminal. No comment is written."

const hubDown = "kban hub not reachable: start it with `kban -d`, then try again"

// relay is one agent session's MCP server: newline-delimited JSON-RPC on
// stdio. Each ask is one request to the hub, held until the question is
// answered; the relay keeps no sitting of its own. A report is one request
// the hub answers at once.
type relay struct {
	id, session, cwd, url string
	out                   io.Writer
	outMu                 sync.Mutex
	mu                    sync.Mutex
	calls                 map[string]context.CancelFunc // by JSON-RPC id
	pend                  *pending
	held                  map[string]string // question id of each held ask, by JSON-RPC id
}

// pending is an ask on a card. Its call has returned; the relay still holds
// the hub request, so the question lives as long as the relay, and writes
// the answer to the card when it comes.
type pending struct {
	id     string
	cancel context.CancelFunc
}

func mcp(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fl := flag.NewFlagSet("kban mcp", flag.ContinueOnError)
	fl.SetOutput(stderr)
	port := fl.Int("p", 4177, "the hub's port")
	if fl.Parse(args) != nil {
		return 1
	}
	r := &relay{id: token(), session: os.Getenv("CLAUDE_CODE_SESSION_ID"), url: fmt.Sprintf("http://127.0.0.1:%d/api/", *port),
		out: stdout, calls: map[string]context.CancelFunc{}, held: map[string]string{}}
	if r.session == "" {
		r.session = r.id
	}
	r.cwd, _ = os.Getwd()
	in := bufio.NewReader(stdin)
	for {
		line, err := in.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			r.handle(line, stderr)
		}
		if err != nil {
			return 0
		}
	}
}

type rpc struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// A line that is not JSON is logged and skipped: ending the relay would cost the session its tool.
func (r *relay) handle(line []byte, stderr io.Writer) {
	var msg rpc
	if err := json.Unmarshal(line, &msg); err != nil {
		fmt.Fprintln(stderr, "kban mcp:", err)
		return
	}
	reply := func(result any) { r.send(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result}) }
	switch msg.Method {
	case "initialize":
		var p struct{ ProtocolVersion string }
		json.Unmarshal(msg.Params, &p)
		reply(map[string]any{"protocolVersion": p.ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "kban", "version": "kban"}})
	case "tools/list":
		reply(map[string]any{"tools": []any{map[string]any{"name": "ask", "description": askDescription, "inputSchema": askSchema},
			map[string]any{"name": "report", "description": reportDescription, "inputSchema": reportSchema},
			map[string]any{"name": "withdraw", "description": withdrawDescription, "inputSchema": withdrawSchema}}})
	case "tools/call":
		var p struct {
			Name      string
			Arguments json.RawMessage
		}
		json.Unmarshal(msg.Params, &p)
		body := map[string]any{"relay": r.id, "session": r.session, "cwd": r.cwd}
		switch p.Name {
		case "ask":
			if text, isErr, onCard := r.askOnCard(p.Arguments, body); onCard {
				r.result(msg.ID, text, isErr)
				return
			}
			var q struct{ ID string }
			json.Unmarshal(p.Arguments, &q)
			r.mu.Lock()
			pd := r.pend
			if pd == nil {
				r.held[string(msg.ID)] = q.ID
			}
			r.mu.Unlock()
			if pd != nil {
				r.result(msg.ID, pd.id+" is still waiting on its card; its answer arrives there as a comment by hub. So withdraw it to ask another.", true)
				return
			}
			body["args"] = p.Arguments
		case "withdraw":
			var a struct{ ID string }
			json.Unmarshal(p.Arguments, &a)
			r.mu.Lock()
			pd := r.pend
			if pd != nil && pd.id == a.ID {
				r.pend = nil
			}
			r.mu.Unlock()
			if pd == nil || pd.id != a.ID {
				r.result(msg.ID, "no question "+a.ID+" is waiting on a card", true)
				return
			}
			pd.cancel()
			r.result(msg.ID, a.ID+" withdrawn", false)
			return
		case "report":
			var a struct{ Text string }
			json.Unmarshal(p.Arguments, &a)
			body["text"] = a.Text
		default:
			r.result(msg.ID, "unknown tool "+p.Name, true)
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		r.mu.Lock()
		r.calls[string(msg.ID)] = cancel
		r.mu.Unlock()
		go r.post(ctx, msg.ID, p.Name, body)
	case "notifications/cancelled":
		var p struct{ RequestID json.RawMessage }
		json.Unmarshal(msg.Params, &p)
		r.mu.Lock()
		if cancel := r.calls[string(p.RequestID)]; cancel != nil {
			cancel()
		}
		r.mu.Unlock()
	case "ping":
		reply(map[string]any{})
	default:
		if msg.ID != nil {
			r.send(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32601, "message": "method not found: " + msg.Method}})
		}
	}
}

// A cancelled call gets no result.
func (r *relay) post(ctx context.Context, id json.RawMessage, tool string, payload map[string]any) {
	defer func() {
		r.mu.Lock()
		r.calls[string(id)]()
		delete(r.calls, string(id))
		delete(r.held, string(id))
		r.mu.Unlock()
	}()
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", r.url+tool, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	var text []byte
	if err == nil {
		text, err = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	switch {
	case ctx.Err() != nil:
	case err != nil:
		r.result(id, hubDown, true)
	default:
		r.result(id, strings.TrimSpace(string(text)), resp.StatusCode != 200)
	}
}

// askOnCard takes an ask that names a card. It checks the question and the
// card now, so a mistake comes back to the caller, then holds the hub
// request in the background. onCard is false for an ask without a card.
func (r *relay) askOnCard(raw json.RawMessage, body map[string]any) (text string, isErr, onCard bool) {
	var args map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&args) != nil {
		return "", false, false
	}
	if _, has := args["card"]; !has {
		return "", false, false
	}
	card, _ := args["card"].(string)
	board, _ := args["board"].(string)
	if board == "" {
		board = "TODO.json"
	}
	delete(args, "card")
	delete(args, "board")
	if card == "" {
		return "card: a card id, as kban show prints it", true, true
	}
	if p := invalid(args, map[string]string{}); p != "" {
		return p, true, true
	}
	path := board
	if !filepath.IsAbs(path) {
		path = filepath.Join(r.cwd, path)
	}
	if _, err := update(path, func(b *Board) error { _, _, err := find(b, card); return err }); err != nil {
		return board + ": " + err.Error(), true, true
	}
	host := strings.TrimSuffix(strings.TrimPrefix(r.url, "http://"), "/api/")
	if c, err := net.DialTimeout("tcp", host, time.Second); err != nil {
		return hubDown, true, true
	} else {
		c.Close()
	}
	id := args["id"].(string)
	r.mu.Lock()
	for _, h := range r.held {
		r.mu.Unlock()
		return h + " is still open; its answer arrives as that ask's result.", true, true
	}
	if o := r.pend; o != nil {
		r.mu.Unlock()
		return o.id + " is still waiting on its card; its answer arrives there as a comment by hub. So withdraw it to ask another.", true, true
	}
	ctx, cancel := context.WithCancel(context.Background())
	pd := &pending{id: id, cancel: cancel}
	r.pend = pd
	r.mu.Unlock()
	stripped, _ := json.Marshal(args)
	body["args"] = json.RawMessage(stripped)
	go r.hold(ctx, pd, body, path, card, args["question"])
	out, _ := json.Marshal(map[string]string{"id": id, "status": "pending", "card": card, "board": board})
	return string(out), false, true
}

// hold waits for the hub's answer to a question on a card and comments it
// there. A withdrawn question, or one whose relay ended, writes nothing.
func (r *relay) hold(ctx context.Context, pd *pending, payload map[string]any, path, card string, question any) {
	defer func() {
		r.mu.Lock()
		if r.pend == pd {
			r.pend = nil
		}
		r.mu.Unlock()
		pd.cancel()
	}()
	data, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", r.url+"ask", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	var text []byte
	if err == nil {
		text, err = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	if ctx.Err() != nil {
		return
	}
	var note string
	switch {
	case err != nil:
		note = fmt.Sprintf("%s closed with no answer: %s; ask again.", pd.id, hubDown)
	case resp.StatusCode != 200:
		note = fmt.Sprintf("%s closed with no answer: %s; ask again.", pd.id, strings.TrimSpace(string(text)))
	default:
		note = fmt.Sprintf("Answer to %s, %v\n\n```json\n%s\n```", pd.id, question, strings.TrimSpace(string(text)))
		// The JSON alone reads as no answer yet to an agent that forgot the tool's help.
		var a answer
		if json.Unmarshal(text, &a) == nil && a.Kind == "ask" {
			note = fmt.Sprintf("%s is not decided: the user wants more before deciding. Explain it plainer, with a worked example, then ask %s again.\n\n", pd.id, pd.id) + note
		}
	}
	// The hub has closed the question, so this comment is the answer's only
	// copy: an unreadable board is waited out, not given up on.
	for {
		_, err := update(path, func(b *Board) error {
			c, i, err := find(b, card)
			if err != nil {
				return err
			}
			cd := &b.Columns[c].Cards[i]
			cd.Comments = append(cd.Comments, Comment{"hub", time.Now().Format(commentTime), note})
			return nil
		})
		if err == nil {
			return
		}
		if !errors.As(err, new(unreadable)) {
			// ponytail: a deleted card or board loses the answer to stderr; a fallback card if that bites.
			fmt.Fprintf(os.Stderr, "kban mcp: %s not written to %s: %v\n%s\n", pd.id, path, err, note)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (r *relay) result(id json.RawMessage, text string, isError bool) {
	r.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}}, "isError": isError}})
}

func (r *relay) send(msg any) {
	data, _ := json.Marshal(msg)
	r.outMu.Lock()
	defer r.outMu.Unlock()
	r.out.Write(append(data, '\n'))
}
