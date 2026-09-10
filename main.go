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
)

const starter = `# Todo
- [ ] Welcome
  Drag cards between columns or use the keyboard: arrows move, Enter edits, n adds, x deletes, u undoes.
  Every change is written back to this file, and edits to the file show up here.

# Doing

# Done
`

func main() {
	port := flag.Int("p", 4177, "port to listen on (tries the next few if taken)")
	noOpen := flag.Bool("no-open", false, "do not open a browser")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: kban [flags] [board.md]\n\nHeadings are columns, checkbox items are cards. Default file: TODO.md\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	path := "TODO.md"
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
		f.WriteString(starter)
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
