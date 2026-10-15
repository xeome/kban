# kban

A JSON file served as a kanban board on localhost. Humans drag cards in a
browser; agents edit the same file. Both at once is the point — the
file is the only state, and it is meant to be a shared work queue between a
person and the agents working alongside them.

## Commands

    go test ./...          # everything; ~1s
    go run . board.json    # serve a board (-p port, -no-open)

## Layout

    board.go    Parse / Write / Merge — the format and the conflict rules
    server.go   HTTP + SSE, file read/write, the 409 on an unreadable file
    main.go     flags, port picking, browser opening
    ui/         embedded (go:embed) vanilla JS; no build step, no deps

## Rules that break things when ignored

- **The file is the database.** No sidecar state, no ids in the file.
  Cards and columns are identified by title; duplicates are numbered by
  position during a merge. Comments follow their card's title.
- **The format is strict, and an unreadable file is never written.** `Parse`
  rejects unknown fields, trailing data and syntax errors with the line, and
  the server answers 409 instead of overwriting. Accepting and dropping a
  field would silently delete what an agent wrote. One exception: a key
  repeated in one object keeps its last value (encoding/json), and keys match
  case-insensitively; the starter instructions tell agents to append to the
  existing `comments`.
- **`Parse` and `Write` must round-trip.** `Write(Parse(s)) == s` for any file
  kban itself produced.
- **The browser never merges.** It sends `{base, board}`; the server merges
  against disk and returns the file it wrote. Keep it that way — two merge
  implementations will disagree. Undo is the same request with the step's
  `{after, before}`; a modal field is undone as an ordinary edit instead,
  because a title revert sent as `{after, before}` drops what the card gained
  since.
- **The server stores what it merged, unaltered.** The JSON encoder is the
  trust boundary: no text can add structure. Normalising text on the way in
  makes the browser's next base disagree with disk, and an edit becomes a
  second card.
- **Writes are atomic** (temp file + rename) — an agent reading the file must
  never see a half-written board.
- Changes to the file are picked up by polling, within 500ms.
- **Render never touches a focused field.** The modal follows its card by
  key (title + repeat number) across every board the server pushes, so an
  agent's comment lands while you type without moving your caret.

## Testing

`board_test.go` covers the format and merge rules; `server_test.go` covers the
loop that matters — an agent editing the file while a browser holds a stale
view — over a real HTTP server and a real temp file.

Adding a merge or format rule means a case in those tables. Verify a new test
fails before it passes: break the line it covers, run it, put the line back.

The UI has no automated tests. After touching `ui/`, check by hand: drag a card
across columns, open one and edit it, comment, `u` to undo, then `cat` the file
and confirm it says what the screen says. Then append a comment to the open
card with `jq` while typing in its notes: it appears, the caret stays.
