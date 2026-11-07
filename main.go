package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Agents read a board's instructions first, so what they must know goes there.
func starter(name string) Board {
	return Board{
		Instructions: "This board is shared: the author uses it in a browser, agents use the kban commands. " +
			"Agents: take cards from Todo, move them between columns as you work, and expect new ones to appear. " +
			"Change the board only with these commands, never by editing this file: " +
			"kban show -f " + name + " [ID] prints the board, or one card, with each card's id; " +
			"kban add -f " + name + " COLUMN TITLE prints the new card's id; " +
			"kban move -f " + name + " ID COLUMN; " +
			"kban set -f " + name + " ID title|notes TEXT; " +
			"kban comment -f " + name + " -a <your name> ID TEXT reports on a card. " +
			"A card is named by its id, never its title. TEXT - reads stdin.",
		Columns: []Column{
			{Title: "Todo", Cards: []Card{{
				ID:    newID(),
				Title: "Welcome",
				Notes: "Click a card or press Enter to open it. Arrows select, n adds a card, u undoes.\n" +
					"Every change is written back to this file, and edits to the file show up here.",
				Comments: []Comment{{Author: "kban", Time: time.Now().Format(time.RFC3339),
					Text: "Agents and you talk here. Ctrl+Enter posts a comment."}},
			}}},
			{Title: "Doing"},
			{Title: "Done"},
		},
	}
}

// childEnv marks the detached kban that -d starts. It only suppresses the
// default file, since its parent already registered the one named.
const childEnv = "KBAN_DETACHED"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		os.Exit(mcp(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && commands[os.Args[1]] != "" {
		os.Exit(cli(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	port := flag.Int("p", 4177, "port to listen on")
	noOpen := flag.Bool("no-open", false, "do not open a browser")
	detached := flag.Bool("d", false, "run the hub in the background; with no file, start it alone")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: kban [flags] [board.json]\n       kban show|add|move|set|comment|init [-f board.json] ...\n       kban mcp [-p port]   grill's ask tool for an agent session, answered in the hub\n\n"+
			"A board is a JSON file of columns and cards. Default file: TODO.json\n"+
			"One kban serves every board listed in ~/.config/kban/boards; kban board.json adds it there.\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	path := flag.Arg(0)
	if path == "" && !*detached && os.Getenv(childEnv) == "" {
		path = "TODO.json"
	}
	if err := run(path, *port, !*noOpen, *detached); err != nil {
		fmt.Fprintln(os.Stderr, "kban:", err)
		os.Exit(1)
	}
}

func run(path string, port int, browse, detached bool) error {
	registry, err := registryPath()
	if err != nil {
		return err
	}
	if path != "" {
		if path, err = filepath.Abs(path); err != nil {
			return err
		}
		if err := create(path, starter(filepath.Base(path))); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		if err := register(registry, path); err != nil {
			return err
		}
	}
	ln, url, err := claim(port, path)
	if err != nil {
		return err
	}
	fmt.Println(url)
	if ln != nil && detached {
		ln.Close()
		pid, err := detach(port)
		if err != nil {
			return err
		}
		fmt.Println("kban runs in the background, pid", pid)
		ln = nil
	}
	if browse && path != "" {
		openBrowser(url)
	}
	if ln == nil { // a hub serves this port: one already running, or the one just detached
		return nil
	}
	return serve(ln, registry, browse)
}

func claim(port int, path string) (net.Listener, string, error) {
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	url := base + "/"
	if path != "" {
		url = base + "/b/" + fileID(path)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err == nil {
		return ln, url, nil
	}
	if hubAt(base) {
		return nil, url, nil
	}
	return nil, "", fmt.Errorf("port %d is taken by something other than a kban hub", port)
}

func hubAt(base string) bool {
	c := http.Client{Timeout: 2 * time.Second}
	r, err := c.Get(base + "/api/boards")
	if err != nil {
		return false
	}
	defer r.Body.Close()
	var list []json.RawMessage
	return r.StatusCode == 200 && json.NewDecoder(r.Body).Decode(&list) == nil
}

func detach(port int) (int, error) {
	p, err := startDetached(port)
	if err != nil {
		return 0, err
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if hubAt(base) {
			return p.Pid, nil
		}
	}
	return 0, fmt.Errorf("the background kban (pid %d) did not answer on port %d within 2s", p.Pid, port)
}

func serve(ln net.Listener, registry string, browse bool) error {
	h := newHub(registry, currentUser())
	if !browse {
		h.browse = func(string) {}
	}
	go h.watch()
	// The tailnet address too, so the boards open from the owner's other
	// devices. Never 0.0.0.0.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "tailscale", "ip", "-4").Output()
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if ip := net.ParseIP(first); ip.To4() != nil {
		_, port, _ := net.SplitHostPort(ln.Addr().String())
		if tln, err := net.Listen("tcp", net.JoinHostPort(ip.String(), port)); err != nil {
			fmt.Fprintln(os.Stderr, "kban: not on the tailnet:", err)
		} else {
			h.mu.Lock()
			h.tail = "http://" + tln.Addr().String()
			h.mu.Unlock()
			go http.Serve(tln, h.tailnet())
		}
	}
	return http.Serve(ln, h.handler())
}

func openBrowser(url string) {
	args := []string{"xdg-open", url}
	switch runtime.GOOS {
	case "darwin":
		args = []string{"open", url}
	case "windows":
		args = []string{"rundll32", "url.dll,FileProtocolHandler", url}
	}
	cmd := exec.Command(args[0], args[1:]...)
	if cmd.Start() == nil { // best effort; the URL is printed anyway
		go cmd.Wait() // the hub opens one per unacked question, so it reaps each
	}
}
