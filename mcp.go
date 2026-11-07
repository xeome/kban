package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
)

// grill's ask tool, schema and description unchanged from grill's own server.
//
//go:embed ask.json
var askSchema json.RawMessage

const askDescription = "Put one grill-me decision to the user in the session's browser tab and wait for the answer. Returns JSON {id, kind, option, label, words}: kind is option, defer, text (an answer in the user's own words, no option picked) or ask (the user wants more before deciding: re-ask the same id with this tool; option and label, when set, are a lean, not a decision). Calls longer than 2 minutes move to a background task: end your turn, the answer arrives as a task notification."

const hubDown = "kban hub not reachable: start it with `kban -d`, then ask again"

// relay is one agent session's MCP server: newline-delimited JSON-RPC on
// stdio. Each ask is one request to the hub, held until the question is
// answered; the relay keeps no sitting of its own.
type relay struct {
	id, session, cwd, url string
	out                   io.Writer
	outMu                 sync.Mutex
	mu                    sync.Mutex
	calls                 map[string]context.CancelFunc // by JSON-RPC id
}

func mcp(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fl := flag.NewFlagSet("kban mcp", flag.ContinueOnError)
	fl.SetOutput(stderr)
	port := fl.Int("p", 4177, "the hub's port")
	if fl.Parse(args) != nil {
		return 1
	}
	r := &relay{id: token(), session: os.Getenv("CLAUDE_CODE_SESSION_ID"), url: fmt.Sprintf("http://127.0.0.1:%d/api/grill/ask", *port),
		out: stdout, calls: map[string]context.CancelFunc{}}
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
			"serverInfo": map[string]any{"name": "grill", "version": "kban"}})
	case "tools/list":
		reply(map[string]any{"tools": []any{map[string]any{"name": "ask", "description": askDescription, "inputSchema": askSchema}}})
	case "tools/call":
		var p struct {
			Name      string
			Arguments json.RawMessage
		}
		json.Unmarshal(msg.Params, &p)
		if p.Name != "ask" {
			r.result(msg.ID, "unknown tool "+p.Name, true)
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		r.mu.Lock()
		r.calls[string(msg.ID)] = cancel
		r.mu.Unlock()
		go r.ask(ctx, msg.ID, p.Arguments)
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
func (r *relay) ask(ctx context.Context, id, args json.RawMessage) {
	defer func() {
		r.mu.Lock()
		r.calls[string(id)]()
		delete(r.calls, string(id))
		r.mu.Unlock()
	}()
	body, _ := json.Marshal(map[string]any{"relay": r.id, "session": r.session, "cwd": r.cwd, "args": args})
	req, _ := http.NewRequestWithContext(ctx, "POST", r.url, bytes.NewReader(body))
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
