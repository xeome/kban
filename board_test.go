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
          "id": "k3x9pq2a",
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
          "id": "m7bz4ttd",
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
		{"card with no id", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"id\": \"x\", \"title\": \"a\"},\n      {\"title\": \"b\"}\n    ]}\n  ]\n}\n",
			`line 5: card "b" has no id`},
		{"repeated id", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [{\"id\": \"x\", \"title\": \"a\"}]},\n    {\"title\": \"U\", \"cards\": [\n      {\"id\": \"x\", \"title\": \"b\"}\n    ]}\n  ]\n}\n",
			`line 5: card "b" has the id "x" of an earlier card`},
		{"meta number value", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"id\": \"a\", \"title\": \"a\", \"meta\": {\"k\": 1}}\n    ]}\n  ]\n}\n", "line 4:"},
		{"meta object value", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"id\": \"a\", \"title\": \"a\", \"meta\": {\"k\": {}}}\n    ]}\n  ]\n}\n", "line 4:"},
		{"meta array value", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"id\": \"a\", \"title\": \"a\", \"meta\": {\"k\": []}}\n    ]}\n  ]\n}\n", "line 4:"},
		{"unknown field after a card with meta", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"id\": \"a\", \"title\": \"a\", \"meta\": {\"k\": \"v\"}},\n      {\"id\": \"b\", \"title\": \"b\",\n       \"bogus\": 1}\n    ]}\n  ]\n}\n",
			`line 6: json: unknown field "bogus"`},
		{"repeated id after a card with meta", "{\n  \"columns\": [\n    {\"title\": \"T\", \"cards\": [\n      {\"id\": \"x\", \"title\": \"a\", \"meta\": {\"k\": \"v\"}},\n      {\"id\": \"x\", \"title\": \"b\"}\n    ]}\n  ]\n}\n",
			`line 5: card "b" has the id "x" of an earlier card`},
		{"null card", "{\"columns\": [{\"title\": \"T\", \"cards\": [{\"id\": \"x\", \"title\": \"a\"},\n  null]}]}\n", `line 2: card "" has no id`},
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
		c.Cards = append(c.Cards, Card{ID: t, Title: t})
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
			board(Column{Title: "Todo", Cards: []Card{{ID: "b", Title: "b", Notes: "note"}, {ID: "c", Title: "c"}}}, col("Done", "a"))},
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
		{"both add the same title: two cards",
			board(col("Todo", "a", "b", "c"), col("Done")).with(0, -1, func(c *Card) { *c = Card{ID: "n1", Title: "n"} }),
			board(col("Todo", "a", "b", "c"), col("Done")).with(1, -1, func(c *Card) { *c = Card{ID: "n2", Title: "n"} }),
			board(col("Todo", "a", "b", "c"), col("Done")).with(0, -1, func(c *Card) { *c = Card{ID: "n1", Title: "n"} }).
				with(1, -1, func(c *Card) { *c = Card{ID: "n2", Title: "n"} })},
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

// A rename or a comment on one side and an edit on the other are two edits of
// one card. Both land, where a per-card "client wins" rule would drop one.
func TestMergeComments(t *testing.T) {
	me, agent, dup := Comment{"me", "t1", "hi"}, Comment{"claude", "t2", "done"}, Comment{"claude", "t0", "same"}
	on := func(b Board, notes string, cs ...Comment) Board {
		return b.with(0, 0, func(c *Card) { c.Notes, c.Comments = notes, cs })
	}
	plain := board(col("Todo", "a", "b"))
	edit := func(f func(*Card)) Board { return plain.with(0, 0, f) }
	rename := func(c *Card) { c.Title = "a2" }
	renamed := func(notes string, cs ...Comment) Board { return on(plain, notes, cs...).with(0, 0, rename) }
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
		{"client renames, disk comments", plain, edit(rename), on(plain, "", agent), renamed("", agent)},
		{"disk renames, client comments", plain, on(plain, "", agent), edit(rename), renamed("", agent)},
		{"client renames, disk edits notes", plain, edit(rename), on(plain, "n"), renamed("n")},
		{"disk renames, client edits notes", plain, on(plain, "n"), edit(rename), renamed("n")},
		{"both rename: client wins", plain, edit(rename), edit(func(c *Card) { c.Title = "disk" }), edit(rename)},
	}
	for _, tc := range cases {
		if got := Merge(tc.base, tc.client, tc.disk); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}

func (b Board) with(c, i int, edit func(*Card)) Board {
	out := Board{Instructions: b.Instructions}
	for _, col := range b.Columns {
		col.Cards = append([]Card(nil), col.Cards...)
		out.Columns = append(out.Columns, col)
	}
	if i == -1 {
		out.Columns[c].Cards = append(out.Columns[c].Cards, Card{})
		i = len(out.Columns[c].Cards) - 1
	}
	edit(&out.Columns[c].Cards[i])
	return out
}

func TestMetaRoundTrip(t *testing.T) {
	src := `{
  "instructions": "",
  "columns": [
    {
      "title": "T",
      "cards": [
        {
          "id": "a",
          "title": "a",
          "meta": {
            "b": "two",
            "k": "1"
          }
        }
      ]
    }
  ]
}
`
	b, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	if got := Write(b); got != src {
		t.Fatalf("round trip drifted:\n%s", got)
	}
	empty := "{\"columns\": [{\"title\": \"T\", \"cards\": [{\"id\": \"a\", \"title\": \"a\", \"meta\": {\"k\": \"\", \"j\": null}}]}]}"
	if b, err := Parse(empty); err != nil || strings.Contains(Write(b), `"meta"`) {
		t.Fatalf("an empty or null value must be written as no key: %v\n%s", err, Write(b))
	}
	mine := board(col("T", "a")).with(0, 0, func(c *Card) { c.Meta = map[string]string{"k": "", "j": "x"} })
	if got := Write(mine); strings.Contains(got, `"k"`) || !strings.Contains(got, `"j": "x"`) {
		t.Fatalf("Write = %s, want j kept and the empty k dropped", got)
	}
	if _, ok := mine.Columns[0].Cards[0].Meta["k"]; !ok {
		t.Fatalf("Write changed the caller's meta")
	}
}

// Each row changes something on both sides, so Merge's whole-board shortcuts
// do not answer it and the per-key rule is what runs.
func TestMergeMeta(t *testing.T) {
	plain := board(col("Todo", "a"))
	on := func(notes string, m map[string]string) Board {
		return plain.with(0, 0, func(c *Card) { c.Notes, c.Meta = notes, m })
	}
	kv := func(kv ...string) map[string]string {
		m := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	cases := []struct {
		name                     string
		base, client, disk, want Board
	}{
		{"client and disk set different keys",
			on("", kv("k", "v")), on("", kv("k", "v", "c", "1")), on("", kv("k", "v", "d", "2")), on("", kv("k", "v", "c", "1", "d", "2"))},
		{"both set one key: client wins",
			on("", kv("k", "v")), on("", kv("k", "client")), on("", kv("k", "disk")), on("", kv("k", "client"))},
		{"client removes a key, disk adds another",
			on("", kv("k", "v")), on("", nil), on("", kv("k", "v", "j", "1")), on("", kv("j", "1"))},
		{"disk removes a key, client edits notes",
			on("", kv("k", "v")), on("n", kv("k", "v")), on("", nil), on("n", nil)},
		{"client edits notes, disk sets a key",
			on("", nil), on("n", nil), on("", kv("k", "v")), on("n", kv("k", "v"))},
	}
	for _, tc := range cases {
		if got := Merge(tc.base, tc.client, tc.disk); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
}
