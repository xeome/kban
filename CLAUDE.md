# kban

A markdown file served as a kanban board on localhost. Humans drag cards in a
browser; agents edit the same file as text. Both at once is the point — the
file is the only state, and it is meant to be a shared work queue between a
person and the agents working alongside them.

## Commands

    go test ./...          # everything; ~1s
    go run . board.md      # serve a board (-p port, -no-open)

## Layout

    board.go    Parse / Write / Merge — the format and the conflict rules
    server.go   HTTP + SSE, file read/write, input cleaning
    main.go     flags, port picking, browser opening
    ui/         embedded (go:embed) vanilla JS; no build step, no deps

## Rules that break things when ignored

- **The file is the database.** No sidecar state, no ids in the markdown.
  Cards and columns are identified by title; duplicates are numbered by
  position during a merge.
- **The format is exhaustive and a save rewrites the file.** Inside a column,
  only `- [ ] card` lines and indented notes under them survive; loose prose, a
  bullet without a checkbox, a numbered list are all dropped on the next save.
  Agents writing to the board must use the checkbox form — there is no second
  syntax for a card, and nothing warns you when a line is discarded.
- **`Parse` and `Write` must round-trip.** `Write(Parse(s)) == s` for any file
  kban itself produced. Checkbox state is *derived* (last column is `[x]`),
  never read from the file.
- **The browser never merges.** It sends `{base, board}`; the server merges
  against disk and returns the canonical board. Keep it that way — two merge
  implementations will disagree.
- **Titles are one line.** `clean` in server.go is the trust boundary; a title
  containing a newline would otherwise rewrite the file's structure.
- **Writes are atomic** (temp file + rename) — an agent reading the file must
  never see a half-written board.
- Changes to the file are picked up by polling, within 500ms.

## Testing

`board_test.go` covers the format and merge rules; `server_test.go` covers the
loop that matters — an agent editing the file while a browser holds a stale
view — over a real HTTP server and a real temp file.

Adding a merge or format rule means a case in those tables. Verify a new test
fails before it passes: break the line it covers, run it, put the line back.

The UI has no automated tests. After touching `ui/`, check by hand: drag a card
across columns, edit one, `u` to undo, then `cat` the file and confirm it says
what the screen says.
