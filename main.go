package main

import (
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
		Instructions: "This board is shared: the author uses it in a browser, agents edit this file. " +
			"Agents: take cards from Todo, move them between columns as you work, and expect new ones to appear. " +
			`A card is {"title", "notes", "comments"}; report on one by appending to its "comments" array ` +
			`{"author": "<your name>", "time": "<date -Iseconds>", "text": "..."}, never by adding a second "comments" key. ` +
			"Any other field makes the board unreadable until it is removed. " +
			"Change the file in one step from what is on disk now (jq '...' " + name + " > t && mv t " + name + "), never from a copy read earlier.",
		Columns: []Column{
			{Title: "Todo", Cards: []Card{{
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

func main() {
	port := flag.Int("p", 4177, "port to listen on (tries the next few if taken)")
	noOpen := flag.Bool("no-open", false, "do not open a browser")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: kban [flags] [board.json]\n\nA board is a JSON file of columns and cards. Default file: TODO.json\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	path := "TODO.json"
	if flag.NArg() > 0 {
		path = flag.Arg(0)
	}
	if err := run(path, *port, !*noOpen); err != nil {
		fmt.Fprintln(os.Stderr, "kban:", err)
		os.Exit(1)
	}
}

func run(path string, port int, open bool) error {
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644); err == nil {
		if old := strings.TrimSuffix(path, ".json") + ".md"; old != path && exists(old) {
			fmt.Fprintf(os.Stderr, "kban: %s is a markdown board, which kban no longer reads; %s starts empty\n", filepath.Base(old), filepath.Base(path))
		}
		f.WriteString(Write(starter(filepath.Base(path))))
		f.Close()
	} else if !errors.Is(err, fs.ErrExist) {
		return err
	}
	ln, port, err := listen(port)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Printf("%s\n%s\n", path, url)
	if open {
		openBrowser(url)
	}
	s := newServer(path)
	go s.watch()
	return http.Serve(ln, s.handler())
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func listen(port int) (net.Listener, int, error) {
	var err error
	for p := port; p < port+10; p++ {
		var ln net.Listener
		if ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			return ln, p, nil
		}
	}
	return nil, 0, err
}

func openBrowser(url string) {
	args := []string{"xdg-open", url}
	switch runtime.GOOS {
	case "darwin":
		args = []string{"open", url}
	case "windows":
		args = []string{"rundll32", "url.dll,FileProtocolHandler", url}
	}
	exec.Command(args[0], args[1:]...).Start() // best effort; the URL is printed anyway
}
