package main

import (
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
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
