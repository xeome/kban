package main

import (
	"reflect"
	"testing"
)

const sample = `Notes above the board
stay as they are.

# Todo
- [ ] Write parser
  first line
  second line
- [ ] fix: colon in title

# Doing

# Done
- [x] Set up repo
`

func TestRoundTrip(t *testing.T) {
	b := Parse(sample)
	if got := Write(b); got != sample {
		t.Fatalf("round trip drifted:\n%s", got)
	}
	if b.Columns[0].Cards[0].Body != "first line\nsecond line" {
		t.Fatalf("body = %q", b.Columns[0].Cards[0].Body)
	}
	if b.Columns[0].Cards[1].Title != "fix: colon in title" {
		t.Fatalf("title = %q", b.Columns[0].Cards[1].Title)
	}
}

func TestParseNormalizes(t *testing.T) {
	b := Parse("# A\n- [x] done mark ignored\n\n\n# B\n- [ ] x\n  para one\n\n  para two\n\nstray prose\n  orphan\n")
	if b.Columns[1].Cards[0].Body != "para one\n\npara two" {
		t.Fatalf("body = %q", b.Columns[1].Cards[0].Body)
	}
	if got, want := Write(b), "# A\n- [ ] done mark ignored\n\n# B\n- [x] x\n  para one\n\n  para two\n"; got != want {
		t.Fatalf("got:\n%s", got)
	}
}

func board(cols ...Column) Board { return Board{Columns: cols} }
func col(title string, titles ...string) Column {
	c := Column{Title: title}
	for _, t := range titles {
		c.Cards = append(c.Cards, Card{Title: t})
	}
	return c
}

func TestMerge(t *testing.T) {
	base := board(col("Todo", "a", "b", "c"), col("Done"))
	cases := []struct {
		name               string
		client, disk, want Board
	}{
		{"client moves, disk edits body",
			board(col("Todo", "b", "c"), col("Done", "a")),
			board(col("Todo", "a", "b", "c"), col("Done")).withBody(0, 1, "note"),
			board(Column{Title: "Todo", Cards: []Card{{Title: "b", Body: "note"}, {Title: "c"}}}, col("Done", "a"))},
		{"client deletes, disk adds",
			board(col("Todo", "a", "c"), col("Done")),
			board(col("Todo", "a", "b", "c", "d"), col("Done")),
			board(col("Todo", "a", "c", "d"), col("Done"))},
		{"disk deletes what client edited",
			board(col("Todo", "a", "b", "c"), col("Done")).withBody(0, 1, "x"),
			board(col("Todo", "a", "c"), col("Done")),
			board(col("Todo", "a", "c"), col("Done"))},
		{"client reorders, disk moves another",
			board(col("Todo", "c", "b", "a"), col("Done")),
			board(col("Todo", "a", "b"), col("Done", "c")),
			board(col("Todo", "b", "a"), col("Done", "c"))},
		{"client renames column, disk adds card to it",
			board(col("Backlog", "a", "b", "c"), col("Done")),
			board(col("Todo", "a", "b", "c", "d"), col("Done")),
			board(col("Backlog", "a", "b", "c", "d"), col("Done"))},
		{"both edit same body: client wins",
			base.withBody(0, 0, "client"),
			base.withBody(0, 0, "disk"),
			base.withBody(0, 0, "client")},
		{"disk removes the column a client card moved into",
			board(col("Todo", "b", "c"), col("Done", "a")),
			board(col("Todo", "a", "b", "c")),
			board(col("Todo", "b", "c", "a"))},
		{"both add the same title: client's column wins",
			board(col("Todo", "a", "b", "c", "n"), col("Done")),
			board(col("Todo", "a", "b", "c"), col("Done", "n")),
			board(col("Todo", "a", "b", "c", "n"), col("Done"))},
	}
	for _, tc := range cases {
		if got := Merge(base, tc.client, tc.disk); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}

func (b Board) withBody(c, i int, body string) Board {
	out := Board{Prelude: b.Prelude}
	for _, col := range b.Columns {
		col.Cards = append([]Card(nil), col.Cards...)
		out.Columns = append(out.Columns, col)
	}
	out.Columns[c].Cards[i].Body = body
	return out
}
