# kban

A markdown file as a kanban board, served on localhost.

## Install

    go install github.com/xeome/kban@latest

Or from a clone, into `$(go env GOPATH)/bin`:

    go install .

## Use

    kban board.md            # default: ./TODO.md, created if missing

Headings are columns, checkbox items are cards, indented lines under a card
are its notes. Text above the first heading is kept as is. Cards in the last
column are written as `[x]`.

    # Todo
    - [ ] Write parser
      first line of notes
      second line

    # Done
    - [x] Set up repo

Inside a column only checkbox items and their indented notes are kept; other
lines are dropped when the board is next saved.

Every edit is written back to the file; edits to the file show up in the
browser. Concurrent edits are merged card by card, with the browser's change
winning when both sides touched the same thing.

Click a card to edit it, drag cards and column headers to move them, use the
Add card and Add column buttons, hover for delete. Keys do the same: arrows or
hjkl select, Enter edits, n new card, x delete, Shift+arrows move, u undo,
+ new column.

Flags: `-p 4177` port (next free of ten is used if taken), `-no-open`.
