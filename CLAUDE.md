# kban

A JSON file served as a kanban board on localhost. Humans drag cards in a
browser; agents change the same file with the kban commands. Both at once is the point — the
file is the only state, and it is meant to be a shared work queue between a
person and the agents working alongside them.

## Commands

    go test ./...          # everything; ~1s, no bun needed
    go run . board.json    # serve a board (-p port, -no-open)
    go run . show -f board.json   # the agent commands: show, add, move, set, comment, init

    cd web && bun install --frozen-lockfile  # once, for UI work
    bun build.js           # web/src -> ui/app.js; commit both
    bun test               # Markdown rendering and what it must never emit
    go build -o /tmp/kban .. && bun e2e/check.mjs /tmp/kban [step]
                           # the real binary and UI in headless Chromium

## Layout

    board.go    Parse / Write / Merge — the format and the conflict rules
    server.go   HTTP + SSE, file read/write, the 409 on an unreadable file
    file.go     update: the one way the file is written; create: a new one
    cli.go      the agent commands
    main.go     flags, port picking, browser opening
    ui/         embedded (go:embed) and served as is; app.js is built, never edited
    web/src/    the UI source: store.js (state, saving, keys, drag), view.jsx
                (Preact components), md.js (Markdown for notes and comments)

## Rules that break things when ignored

- **The file is the database, and kban is its only writer.** No sidecar
  state. Every card has an id kban made (`newID`), unique in the file; the
  browser draws its ids from `POST /api/ids`, agents use the commands. A
  column is identified by its title, repeats numbered by position.
- **The format is strict, and an unreadable file is never written.** `Parse`
  rejects unknown fields, trailing data, syntax errors, and a card with no
  id or a repeated one, with the line; the server answers 409 and a command
  exits 2 instead of overwriting. Accepting and dropping a field would
  silently delete what an agent wrote. One exception: a key repeated in one
  object keeps its last value (encoding/json), and keys match
  case-insensitively.
- **`Parse` and `Write` must round-trip.** `Write(Parse(s)) == s` for any file
  kban itself produced.
- **The browser never merges.** It sends `{fileID, base, board}`; the server
  merges against disk and returns the file it wrote. Keep it that way — two
  merge implementations will disagree. Undo is the same request with the
  step's `{after, before}`. `fileID` names the file the tab loaded: the
  server refuses another (412), and a tab reloads when its port serves
  another file, since another kban on the port would otherwise get this
  board's undo steps. A modal field's step is built when the field is left:
  before is the board then with only that field set back, so undo never
  reverts what an agent wrote while you typed.
- **The server stores what it merged, unaltered.** The JSON encoder is the
  trust boundary: no text can add structure, so none is escaped or
  normalised on the way in.
- **Every write to an existing board goes through `update`,** which is atomic (temp file +
  rename) and conditional: it renames only if the file still holds what it
  read, else it reads and changes it again. So a command and a browser save
  landing at once both keep their change, and a reader never sees half a
  board.
- Changes to the file are picked up by polling, within 500ms, and pushed
  over `/api/events`. The page reopens that stream itself after any error
  and loads the board on every open, because Firefox gives up on a silent
  stream after a network change.
- **Render never touches a focused field.** The modal follows its card by
  id across every board the server pushes, so an agent's comment or rename
  lands while you type without moving your caret. Every
  text field Preact owns is a `Field` (view.jsx), which goes uncontrolled
  while focused; always pass its `value`.
- **File text becomes markup only through `md()`;** everything else is
  JSX text. `md()` escapes HTML, renders an image as a link, and shows a
  link to anything but http(s) or mailto as plain text.
  An agent's text must never become markup on the user's localhost page.
- **The committed bundle matches its sources.** `bundle_test.go` hashes
  web/ the way build.js does and fails when ui/app.js is stale or hand-edited, so
  `go install` never needs bun.

## Testing

`board_test.go` covers the format and merge rules; `server_test.go` covers the
loop that matters — an agent editing the file while a browser holds a stale
view — over a real HTTP server and a real temp file; `cli_test.go` covers the
commands.

Adding a merge or format rule means a case in those tables. Verify a new test
fails before it passes: break the line it covers, run it, put the line back.

`web/e2e/check.mjs` drives the real binary in headless Chromium: opening,
stepping, comments landing while you type, undo, the broken-file banner,
the stream reopening after the browser gives up on it or the board fails
to load, a save that never landed, another kban taking the port, the notes
swap, Markdown, and one drag across columns. It covers no drag
within a column and no column drag: after touching the UI, do those by
hand, then `cat` the file and confirm it says what the screen says.
