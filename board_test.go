package main

import (
	"reflect"
	"strings"
	"testing"
)

const sample = `{
  "instructions": "Notes above the board <b>&</b>",
  "columns": [
    {
      "title": "Todo",
      "cards": [
        {
          "title": "Write parser",
          "notes": "first line\nsecond line",
          "comments": [
            {
              "author": "claude",
              "time": "2026-10-15T14:02:00+03:00",
              "text": "done: <x> & y"
            }
          ]
        },
        {
          "title": "fix: colon in title"
        }
      ]
    },
    {
      "title": "Doing",
      "cards": []
    }
  ]
}
`

func TestRoundTrip(t *testing.T) {
	b, err := Parse(sample)
	if err != nil {
		t.Fatal(err)
	}
	if got := Write(b); got != sample {
		t.Fatalf("round trip drifted:\n%s", got)
	}
	card := b.Columns[0].Cards[0]
	if card.Notes != "first line\nsecond line" || len(card.Comments) != 1 || card.Comments[0].Author != "claude" {
		t.Fatalf("card = %+v", card)
	}
	if got := Write(board(col("Doing"))); !strings.Contains(got, `"cards": []`) {
		t.Fatalf("an empty column must be written as an array:\n%s", got)
	}
}

// An agent fixes the file from this message alone.
func TestParseRejects(t *testing.T) {
	cases := []struct{ name, src, want string }{
		{"unknown field", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"title\": \"a\", \"notes\": \"says \\\"note\\\": here\",\n       \"note\": \"typo\"}\n    ]}\n  ]\n}\n",
			`line 5: json: unknown field "note"`},
		{"syntax error", "{\n  \"columns\": [\n    {\"title\": \"T\",}\n  ]\n}\n", "line 3:"},
		{"trailing brace", "{\"columns\": []}\n}\n", "line 2:"},
		{"second object", "{\"columns\": []}\n{\"columns\": []}\n", "line 2:"},
		{"unknown field whose name is valid elsewhere", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"title\": \"a\",\n       \"cards\": []}\n    ]}\n  ]\n}\n",
			`line 5: json: unknown field "cards"`},
		{"empty", " \n", "empty"},
	}
	for _, tc := range cases {
		_, err := Parse(tc.src)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want it to contain %q", tc.name, err, tc.want)
		}
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
		{"client moves, disk edits notes",
			board(col("Todo", "b", "c"), col("Done", "a")),
			board(col("Todo", "a", "b", "c"), col("Done")).with(0, 1, func(c *Card) { c.Notes = "note" }),
			board(Column{Title: "Todo", Cards: []Card{{Title: "b", Notes: "note"}, {Title: "c"}}}, col("Done", "a"))},
		{"client deletes, disk adds",
			board(col("Todo", "a", "c"), col("Done")),
			board(col("Todo", "a", "b", "c", "d"), col("Done")),
			board(col("Todo", "a", "c", "d"), col("Done"))},
		{"disk deletes what client edited",
			board(col("Todo", "a", "b", "c"), col("Done")).with(0, 1, func(c *Card) { c.Notes = "x" }),
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
		{"both edit same notes: client wins",
			base.with(0, 0, func(c *Card) { c.Notes = "client" }),
			base.with(0, 0, func(c *Card) { c.Notes = "disk" }),
			base.with(0, 0, func(c *Card) { c.Notes = "client" })},
		{"disk removes the column a client card moved into",
			board(col("Todo", "b", "c"), col("Done", "a")),
			board(col("Todo", "a", "b", "c")),
			board(col("Todo", "b", "c", "a"))},
		{"both add the same title: client's column wins",
			board(col("Todo", "a", "b", "c", "n"), col("Done")),
			board(col("Todo", "a", "b", "c"), col("Done", "n")),
			board(col("Todo", "a", "b", "c", "n"), col("Done"))},
		{"client reorders columns, disk adds one: it is kept with its cards",
			board(col("Done"), col("Todo", "a", "b", "c")),
			board(col("Todo", "a", "b", "c"), col("Done"), col("Blocked", "x")),
			board(col("Done"), col("Todo", "a", "b", "c"), col("Blocked", "x"))},
		{"both add the same column: one column",
			board(col("Todo", "a", "b", "c"), col("Done"), col("Review")),
			board(col("Todo", "a", "b", "c"), col("Review", "r"), col("Done")),
			board(col("Todo", "a", "b", "c"), col("Done"), col("Review", "r"))},
	}
	for _, tc := range cases {
		if got := Merge(base, tc.client, tc.disk); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}

func TestMergeKeepsCardsWithNoColumn(t *testing.T) {
	cases := []struct {
		name                     string
		base, client, disk, want Board
	}{
		{"client deletes an empty column, disk adds a card to it",
			board(col("A")), board(), board(col("A", "x")), board(col("A", "x"))},
		{"disk empties the board, client adds a card",
			board(col("Todo", "a")), board(col("Todo", "a", "n")), board(), board(col("Todo", "n"))},
	}
	for _, tc := range cases {
		if got := Merge(tc.base, tc.client, tc.disk); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}

// Every row is on one card, where a per-card "client wins" rule would drop
// something.
func TestMergeComments(t *testing.T) {
	me, agent, dup := Comment{"me", "t1", "hi"}, Comment{"claude", "t2", "done"}, Comment{"claude", "t0", "same"}
	on := func(b Board, notes string, cs ...Comment) Board {
		return b.with(0, 0, func(c *Card) { c.Notes, c.Comments = notes, cs })
	}
	plain := board(col("Todo", "a", "b"))
	cases := []struct {
		name                     string
		base, client, disk, want Board
	}{
		{"both add a comment", plain, on(plain, "", me), on(plain, "", agent), on(plain, "", agent, me)},
		{"client deletes one of two identical, disk adds",
			on(plain, "", dup, dup), on(plain, "", dup), on(plain, "", dup, dup, agent), on(plain, "", dup, agent)},
		{"client edits notes, disk adds a comment", plain, on(plain, "n"), on(plain, "", agent), on(plain, "n", agent)},
		{"disk deletes a comment, client edits another card",
			on(plain, "", agent), on(plain, "", agent).with(0, 1, func(c *Card) { c.Notes = "x" }), plain,
			plain.with(0, 1, func(c *Card) { c.Notes = "x" })},
	}
	for _, tc := range cases {
		if got := Merge(tc.base, tc.client, tc.disk); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}

// with returns a copy of b with one card changed.
func (b Board) with(c, i int, edit func(*Card)) Board {
	out := Board{Instructions: b.Instructions}
	for _, col := range b.Columns {
		col.Cards = append([]Card(nil), col.Cards...)
		out.Columns = append(out.Columns, col)
	}
	edit(&out.Columns[c].Cards[i])
	return out
}
