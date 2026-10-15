# kban

A JSON file as a kanban board, served on localhost. You work it in a browser
while agents edit the file; each card carries notes and a comment thread
between you.

## Install

    go install github.com/xeome/kban@latest

Or from a clone, into `$(go env GOPATH)/bin`:

    go install .

## Use

    kban [board.json]        # default ./TODO.json, created if missing

Flags: `-p 4177` port (the next free of ten if taken), `-no-open`.

## The file

```json
{
  "instructions": "Standing instructions for the agents sharing the board",
  "columns": [
    {
      "title": "Todo",
      "cards": [
        {
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

- Cards and columns are identified by title.
- `notes` and `comments` may be left out.
- An agent comments by appending to the card's `comments`, with the time from
  `date -Iseconds`.
- Change the file in one step from what is on disk:
  `jq '...' TODO.json > t && mv t TODO.json`. An agent that edits a copy read
  earlier overwrites whatever changed meanwhile.
- Any other field, a syntax error or trailing text makes the file unreadable.
  The page shows the error with its line, and kban does not write the file
  until it reads again.

When you and an agent change the board at once, each card, column and order
merges separately, and your change wins where both touched the same thing.
Comments from both sides are kept. `u` undoes only your own last action.
