package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// kban takes an unknown word as a board to create, so `kban help` once made
// a board named help and registered it in the hub.
func TestHelpMakesNoBoard(t *testing.T) {
	cwd, config := t.TempDir(), t.TempDir()
	// The port answers, but not as a hub: a kban that went on to serve
	// exits there, after creating and registering, and never opens a browser.
	other := httptest.NewServer(http.NotFoundHandler())
	defer other.Close()
	_, port, _ := net.SplitHostPort(other.Listener.Addr().String())

	kban := func(args ...string) (string, error) {
		cmd := exec.Command(os.Args[0], args...)
		cmd.Env = append(os.Environ(), "KBAN_TEST_MAIN=1", "XDG_CONFIG_HOME="+config)
		cmd.Dir = cwd
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	want, err := kban("-h")
	if err != nil {
		t.Fatalf("kban -h: %v\n%s", err, want)
	}
	got, err := kban("-no-open", "-p", port, "help")
	if err != nil || got != want {
		t.Errorf("kban help: %v\n%s\nwant what -h prints:\n%s", err, got, want)
	}
	for _, p := range []string{filepath.Join(cwd, "help"), filepath.Join(config, "kban", "boards")} {
		if _, err := os.Stat(p); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("kban help left %s (stat: %v)", p, err)
		}
	}
}

// -d once started the hub with only -p, so `kban -d -no-open` still opened
// a browser tab for every question no page acked.
func TestDetachedHubKeepsNoOpen(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the fake browser is an xdg-open on PATH")
	}
	// hub runs kban with its own fake xdg-open alone on PATH, so no git or
	// tailscale answers.
	hub := func(flags ...string) (string, chan string) {
		dir := t.TempDir()
		opened := filepath.Join(dir, "opened")
		if err := os.WriteFile(filepath.Join(dir, "xdg-open"), []byte("#!/bin/sh\necho \"$1\" >> '"+opened+"'\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		_, port, _ := net.SplitHostPort(l.Addr().String())
		l.Close()

		cmd := exec.Command(os.Args[0], append(flags, "-p", port)...)
		cmd.Env = append(os.Environ(), "KBAN_TEST_MAIN=1", "XDG_CONFIG_HOME="+dir, "HOME="+dir, "PATH="+dir)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		_, pid, _ := strings.Cut(strings.TrimSpace(string(out)), "in the background, pid ")
		n, perr := strconv.Atoi(pid)
		if perr == nil {
			t.Cleanup(func() {
				if p, err := os.FindProcess(n); err == nil {
					p.Kill()
				}
			})
		}
		if err != nil || perr != nil {
			t.Fatalf("kban %v: %v\n%s", flags, err, out)
		}

		body, _ := json.Marshal(map[string]any{"relay": "r1", "session": "s1", "cwd": dir, "args": question()})
		returned := make(chan string, 1)
		go func() { // the hub holds an unanswered ask; the kill above ends it
			r, err := http.Post("http://127.0.0.1:"+port+"/api/ask", "application/json", bytes.NewReader(body))
			if err != nil {
				returned <- err.Error()
				return
			}
			b, _ := io.ReadAll(r.Body)
			r.Body.Close()
			returned <- r.Status + " " + string(b)
		}()
		return opened, returned
	}
	quietOpened, quietAsk := hub("-d", "-no-open") // asked first, so its ack moment passes first
	opened, ask := hub("-d")
	held := func() {
		for name, c := range map[string]chan string{"-d": ask, "-d -no-open": quietAsk} {
			select {
			case r := <-c:
				t.Fatalf("kban %s let the ask go before the wait ended: %s", name, r)
			default:
			}
		}
	}

	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		held()
		if _, err := os.Stat(opened); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("kban -d opened no browser in 15s for a question no page acked")
		}
	}
	time.Sleep(time.Second)
	held()
	if b, err := os.ReadFile(quietOpened); err == nil {
		t.Fatalf("kban -d -no-open opened %s", b)
	}
}
