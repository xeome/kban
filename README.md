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

Flags: `-p 4177` port (the next free of ten if taken), `-no-open`.

Agents change the board with these, never by editing the file:

    kban show [-f FILE] [ID]                 # the board, or one card, as JSON
    kban add [-f FILE] COLUMN TITLE          # prints the new card's id
    kban move [-f FILE] ID COLUMN            # to the end of COLUMN
    kban set [-f FILE] ID title|notes TEXT
    kban comment [-f FILE] [-a NAME] ID TEXT

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
