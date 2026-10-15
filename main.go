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

func main() {
	if len(os.Args) > 1 && commands[os.Args[1]] != "" {
		os.Exit(cli(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	port := flag.Int("p", 4177, "port to listen on (tries the next few if taken)")
	noOpen := flag.Bool("no-open", false, "do not open a browser")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: kban [flags] [board.json]\n       kban show|add|move|set|comment|init [-f board.json] ...\n\nA board is a JSON file of columns and cards. Default file: TODO.json\n\n")
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

func run(path string, port int, browse bool) error {
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if err := create(path, starter(filepath.Base(path))); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	ln, port, err := listen(port)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Printf("%s\n%s\n", path, url)
	if browse {
		openBrowser(url)
	}
	s := newServer(path)
	go s.watch()
	return http.Serve(ln, s.handler())
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
