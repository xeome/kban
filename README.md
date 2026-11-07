# kban

A JSON file as a kanban board, served on localhost. You work it in a browser
while agents change it with kban's commands; each card carries notes and a
comment thread between you.

## Install

    go install github.com/xeome/kban@latest

Or from a clone, into `$(go env GOPATH)/bin`:

    go install .

## Use

    kban [board.json]        # default ./TODO.json, created if missing
    kban -d [board.json]     # the same, with the hub in the background

One kban, the hub, serves every board in one tab: a sidebar lists them by
project and marks the ones that changed since you last looked. `kban FILE`
adds the file to `~/.config/kban/boards` (`$XDG_CONFIG_HOME/kban/boards`),
one absolute path per line, and opens it on the hub, starting the hub first
if none runs on the port. Delete a line to drop that board. `kban -d` with no
file starts the hub alone. The hub listens on 127.0.0.1 and, when
`tailscale ip -4` answers, on that address too.

Flags: `-p 4177` port, `-no-open`, `-d` (Unix only).

Agents change the board with these, never by editing the file:

    kban show [-f FILE] [ID]                 # the board, or one card, as JSON
    kban add [-f FILE] COLUMN TITLE          # prints the new card's id
    kban move [-f FILE] ID COLUMN            # to the end of COLUMN
    kban set [-f FILE] ID title|notes TEXT
    kban comment [-f FILE] [-a NAME] ID TEXT
    kban init [-f FILE] [-i TEXT] COLUMN...  # a new board with these columns, no cards

`TEXT` `-` reads stdin. Exit 1 is a usage or lookup error, 2 a file kban
cannot read; neither writes the file.

## The file

```json
{
  "instructions": "Standing instructions for the agents sharing the board",
  "columns": [
    {
      "title": "Todo",
      "cards": [
        {
          "id": "q4mz7kxa",
          "title": "Fix login redirect",
          "notes": "Bottom line: cookie path was wrong.",
          "comments": [
            {
              "author": "claude",
              "time": "2026-10-15T14:02:00+03:00",
              "text": "Fixed on card/login."
            }
          ]
        }
      ]
    }
  ]
}
```

- Every card has an id kban gives it, which commands, branch names and the
  like can use; a column is identified by its title.
- `notes` and `comments` may be left out.
- Any other field, a card with no id or a repeated one, a syntax error or
  trailing text makes the file unreadable. The page shows the error with its
  line, and kban does not write the file until it reads again.

When you and an agent change the board at once, each card, column and order
merges separately, and your change wins where both touched the same thing.
Comments from both sides are kept. `u` undoes only your own last action.
