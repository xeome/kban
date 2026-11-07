package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
)

// With KBAN_TEST_MAIN set, the test binary is kban itself, so a relay runs
// as its own process: one that can be stopped or killed like a session's.
func TestMain(m *testing.M) {
	if os.Getenv("KBAN_TEST_MAIN") != "" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type relayProc struct {
	t    *testing.T
	cmd  *exec.Cmd
	in   io.WriteCloser
	mu   sync.Mutex
	got  map[int]map[string]any
	next int
}

func startRelay(t *testing.T, port, session, dir string) *relayProc {
	t.Helper()
	cmd := exec.Command(os.Args[0], "mcp", "-p", port)
	cmd.Env = append(os.Environ(), "KBAN_TEST_MAIN=1", "CLAUDE_CODE_SESSION_ID="+session)
	cmd.Dir = dir
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	r := &relayProc{t: t, cmd: cmd, in: in, got: map[int]map[string]any{}}
	t.Cleanup(r.kill)
	go func() {
		for sc := bufio.NewScanner(out); sc.Scan(); {
			var m map[string]any
			if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
				t.Errorf("relay wrote %q: %v", sc.Text(), err)
				continue
			}
			if id, ok := m["id"].(float64); ok {
				r.mu.Lock()
				r.got[int(id)] = m
				r.mu.Unlock()
			}
		}
	}()
	if res := r.result(r.call("initialize", map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "test", "version": "0"}}), 5*time.Second); res["result"] == nil {
		t.Fatalf("initialize: %v", res)
	}
	r.notify("notifications/initialized", map[string]any{})
	return r
}

func (r *relayProc) write(msg map[string]any) {
	data, _ := json.Marshal(msg)
	r.in.Write(append(data, '\n'))
}

func (r *relayProc) call(method string, params any) int {
	r.next++
	r.write(map[string]any{"jsonrpc": "2.0", "id": r.next, "method": method, "params": params})
	return r.next
}

func (r *relayProc) notify(method string, params any) {
	r.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (r *relayProc) ask(q map[string]any) int {
	return r.call("tools/call", map[string]any{"name": "ask", "arguments": q})
}

func (r *relayProc) report(text string) int {
	return r.call("tools/call", map[string]any{"name": "report", "arguments": map[string]any{"text": text}})
}

func (r *relayProc) cancel(id int) {
	r.notify("notifications/cancelled", map[string]any{"requestId": id, "reason": "test"})
}

func (r *relayProc) response(id int, d time.Duration) map[string]any {
	for end := time.Now().Add(d); ; time.Sleep(10 * time.Millisecond) {
		r.mu.Lock()
		m := r.got[id]
		r.mu.Unlock()
		if m != nil || time.Now().After(end) {
			return m
		}
	}
}

func (r *relayProc) result(id int, d time.Duration) map[string]any {
	r.t.Helper()
	m := r.response(id, d)
	if m == nil {
		r.t.Fatalf("call %d: no result within %s, so the hub holds it as an open question", id, d)
	}
	return m
}

func (r *relayProc) tool(id int) (string, bool) {
	r.t.Helper()
	res, _ := r.result(id, 5*time.Second)["result"].(map[string]any)
	content, _ := res["content"].([]any)
	if len(content) != 1 {
		r.t.Fatalf("call %d: result %v, want one content item", id, res)
	}
	return content[0].(map[string]any)["text"].(string), res["isError"] == true
}

func (r *relayProc) answerOf(id int) answer {
	r.t.Helper()
	text, isErr := r.tool(id)
	var a answer
	if err := json.Unmarshal([]byte(text), &a); err != nil || isErr {
		r.t.Fatalf("call %d: %q (error %v), want an answer", id, text, isErr)
	}
	return a
}

func (r *relayProc) stop() { r.in.Close(); r.cmd.Wait() }
func (r *relayProc) kill() { r.cmd.Process.Kill(); r.cmd.Wait() }

func portOf(ts *httptest.Server) string {
	_, p, _ := net.SplitHostPort(ts.Listener.Addr().String())
	return p
}

func TestRelayListsAskAndReport(t *testing.T) {
	r := startRelay(t, "1", "s", t.TempDir())
	res := r.result(r.call("tools/list", map[string]any{}), 5*time.Second)
	tools := res["result"].(map[string]any)["tools"].([]any)
	names := []any{}
	for _, tool := range tools {
		names = append(names, tool.(map[string]any)["name"])
	}
	if fmt.Sprint(names) != "[ask report]" {
		t.Fatalf("tools = %v, want ask and report", names)
	}
	if props, _ := tools[1].(map[string]any)["inputSchema"].(map[string]any)["properties"].(map[string]any); props["text"] == nil {
		t.Errorf("report's schema = %v, want a text property", tools[1])
	}
	props := tools[0].(map[string]any)["inputSchema"].(map[string]any)["properties"].(map[string]any)
	for _, f := range questionFields {
		if props[f] == nil {
			t.Errorf("the schema has no %s; the hub checks it", f)
		}
	}
	if m := r.result(r.call("ping", map[string]any{}), 5*time.Second); m["result"] == nil {
		t.Errorf("ping: %v", m)
	}
	r.in.Write([]byte("not json\n"))
	if m := r.result(r.call("nope", map[string]any{}), 5*time.Second); m["error"] == nil {
		t.Errorf("an unknown method: %v, want an error, and a bad line before it must not end the relay", m)
	}
}

func TestRelayWithoutAHub(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	ln.Close()
	r := startRelay(t, port, "s", t.TempDir())
	if text, isErr := r.tool(r.ask(question())); !isErr || text != hubDown {
		t.Errorf("no hub: %q (error %v), want %q", text, isErr, hubDown)
	}
	if text, isErr := r.tool(r.report("done")); !isErr || text != hubDown {
		t.Errorf("a report with no hub: %q (error %v), want %q", text, isErr, hubDown)
	}
}

func TestRelayWhenTheHubDiesMidQuestion(t *testing.T) {
	g := startGrill(t)
	r := g.relay("s")
	id := r.ask(question())
	g.token("s", "D7")
	g.ts.CloseClientConnections()
	if text, isErr := r.tool(id); !isErr || text != hubDown {
		t.Errorf("hub gone mid-question: %q (error %v), want %q", text, isErr, hubDown)
	}
}
