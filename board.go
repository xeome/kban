package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"slices"
	"strings"
)

type Comment struct {
	Author string `json:"author"`
	Time   string `json:"time"`
	Text   string `json:"text"`
}

type Card struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Notes    string    `json:"notes,omitempty"`
	Comments []Comment `json:"comments,omitempty"`
}

type Column struct {
	Title string `json:"title"`
	Cards []Card `json:"cards"`
}

// Board is the whole file. A card is identified by its id, which kban
// assigns; a column by its title.
type Board struct {
	Instructions string   `json:"instructions"`
	Columns      []Column `json:"columns"`
}

// Parse is strict and names the line, because a file kban misreads is a
// file it would overwrite.
func Parse(src string) (Board, error) {
	var b Board
	if strings.TrimSpace(src) == "" {
		return b, errors.New("the file is empty")
	}
	dec := json.NewDecoder(strings.NewReader(src))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return Board{}, locate(src, err)
	}
	end := dec.InputOffset()
	if dec.Decode(&json.RawMessage{}) != io.EOF {
		rest := strings.TrimLeft(src[end:], " \t\r\n")
		return Board{}, fmt.Errorf("line %d: unexpected data after the board", line(src, int64(len(src)-len(rest))))
	}
	if at, err := checkIDs(b); err != nil {
		err = fmt.Errorf("%w; cards are added with kban add, never by editing the file", err)
		// A repeated "cards" key walks a card encoding/json then drops,
		// so the offsets can disagree with b: report no line then.
		if _, cards := scan(src); at < len(cards) {
			err = fmt.Errorf("line %d: %w", line(src, cards[at]), err)
		}
		return Board{}, err
	}
	return b, nil
}

func checkIDs(b Board) (int, error) {
	seen := map[string]bool{}
	i := 0
	for _, col := range b.Columns {
		for _, c := range col.Cards {
			if c.ID == "" {
				return i, fmt.Errorf("card %q has no id", c.Title)
			}
			if seen[c.ID] {
				return i, fmt.Errorf("card %q has the id %q of an earlier card", c.Title, c.ID)
			}
			seen[c.ID] = true
			i++
		}
	}
	return -1, nil
}

// newID returns 8 random characters from [a-z2-7]: 40 bits, so two cards
// on one board share one about once in a trillion boards of a thousand.
func newID() string { return strings.ToLower(rand.Text()[:8]) }

func line(src string, offset int64) int { return strings.Count(src[:offset], "\n") + 1 }

func locate(src string, err error) error {
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syn):
		return fmt.Errorf("line %d: %w", line(src, syn.Offset), err)
	case errors.As(err, &typ):
		return fmt.Errorf("line %d: %w", line(src, typ.Offset), err)
	}
	if strings.Contains(err.Error(), "unknown field") {
		if at, _ := scan(src); at >= 0 {
			return fmt.Errorf("line %d: %w", line(src, at), err)
		}
	}
	return err
}

// scan returns the offset of the first key Board's json tags do not have,
// or -1, and the offset of every card before it. encoding/json names an
// unknown field but not where it is, and the same name can be valid
// elsewhere in the file, so the file is walked against the types instead
// of searched.
func scan(src string) (unknown int64, cards []int64) {
	dec := json.NewDecoder(strings.NewReader(src))
	var walk func(t reflect.Type) int64
	walk = func(t reflect.Type) int64 {
		tok, err := dec.Token()
		if err != nil {
			return -1
		}
		if t == reflect.TypeFor[Card]() {
			cards = append(cards, dec.InputOffset()-1) // a null decodes to a card too
		}
		switch tok {
		case json.Delim('['):
			for dec.More() {
				if at := walk(t.Elem()); at >= 0 {
					return at
				}
			}
			dec.Token()
		case json.Delim('{'):
			for dec.More() {
				k, _ := dec.Token()
				at := dec.InputOffset()
				f, ok := field(t, k.(string))
				if !ok {
					return at
				}
				if at := walk(f.Type); at >= 0 {
					return at
				}
			}
			dec.Token()
		}
		return -1
	}
	return walk(reflect.TypeFor[Board]()), cards
}

// field matches a key the way encoding/json does: case-insensitively.
func field(t reflect.Type, k string) (reflect.StructField, bool) {
	if t.Kind() != reflect.Struct {
		return reflect.StructField{}, false
	}
	for i := range t.NumField() {
		f := t.Field(i)
		if name, _, _ := strings.Cut(f.Tag.Get("json"), ","); strings.EqualFold(name, k) {
			return f, true
		}
	}
	return reflect.StructField{}, false
}

// Write is the canonical form: Parse reads it back to the same bytes.
func Write(b Board) string {
	b.Columns = slices.Clone(b.Columns)
	if b.Columns == nil {
		b.Columns = []Column{}
	}
	for i := range b.Columns {
		if b.Columns[i].Cards == nil {
			b.Columns[i].Cards = []Card{} // an agent appends to an array, not to null
		}
	}
	var w strings.Builder
	enc := json.NewEncoder(&w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	enc.Encode(b) // strings and slices only: it cannot fail
	return w.String()
}

// Merge reconciles concurrent edits. Each unit (instructions, column list, a
// card's notes, a card's column, a column's card order) takes the client's
// value if the client changed it from base, otherwise disk's. Comments are
// a set per card instead: disk's, plus the client's additions, minus the
// client's deletions, so neither side's comment is lost to the other's
// edit. A card's title merges like its notes.
func Merge(base, client, disk Board) Board {
	if Write(client) == Write(base) {
		return disk
	}
	if Write(disk) == Write(base) {
		return client
	}
	b, c, d := index(base), index(client), index(disk)

	cols := d.cols
	if !slices.Equal(c.cols, b.cols) {
		cols = slices.Clone(c.cols)
		for _, ck := range d.cols {
			if !slices.Contains(b.cols, ck) && !slices.Contains(c.cols, ck) {
				cols = append(cols, ck) // disk added it; dropping it would move its cards to the first column
			}
		}
	}
	out := Board{Instructions: pick(client.Instructions, base.Instructions, disk.Instructions)}
	slot := map[string]int{} // column key → index in out; unknown keys land in the first column
	for i, ck := range cols {
		title, ok := c.title[ck]
		if !ok {
			title = d.title[ck]
		}
		out.Columns = append(out.Columns, Column{Title: title})
		slot[ck] = i
	}

	// Which cards survive, and in which column.
	var order []string
	where := map[string]int{}

	// A card whose column is gone lands in the first column; with no
	// column left at all, its own column comes back rather than the card
	// being lost.
	place := func(k, ck string) {
		i, ok := slot[ck]
		if !ok && len(out.Columns) == 0 {
			title, ok := c.title[ck]
			if !ok {
				title = d.title[ck]
			}
			out.Columns = append(out.Columns, Column{Title: title})
			cols = append(cols, ck)
			slot[ck] = 0
		}
		where[k] = i
	}

	for _, k := range d.keys {
		_, inB := b.col[k]
		cck, inC := c.col[k]
		if inB && !inC {
			continue // client deleted
		}
		ck := d.col[k]
		if inC && cck != b.col[k] {
			ck = cck // client moved (or added it on both sides)
		}
		order = append(order, k)
		place(k, ck)
	}
	for _, k := range c.keys {
		_, inD := d.col[k]
		_, inB := b.col[k]
		if inD || inB {
			continue // already placed, or disk deleted
		}
		order = append(order, k)
		place(k, c.col[k])
	}

	merged := func(k string) Card {
		cc, inC := c.card[k]
		bc, inB := b.card[k]
		dc, inD := d.card[k]
		if !inD {
			return cc
		}
		card := dc
		if inC && inB {
			card.Title = pick(cc.Title, bc.Title, dc.Title)
			card.Notes = pick(cc.Notes, bc.Notes, dc.Notes)
		}
		card.Comments = mergeComments(bc.Comments, cc.Comments, dc.Comments)
		return card
	}

	placed := map[string]bool{}
	for i := range out.Columns {
		ck := cols[i]
		seq := d.cards[ck]
		if !slices.Equal(c.cards[ck], b.cards[ck]) {
			seq = c.cards[ck]
		}
		for _, k := range seq {
			if j, ok := where[k]; ok && j == i && !placed[k] {
				placed[k] = true
				out.Columns[i].Cards = append(out.Columns[i].Cards, merged(k))
			}
		}
	}
	for _, k := range order {
		if !placed[k] {
			i := where[k]
			out.Columns[i].Cards = append(out.Columns[i].Cards, merged(k))
		}
	}
	return out
}

func mergeComments(base, client, disk []Comment) []Comment {
	bk, ck, dk := commentKeys(base), commentKeys(client), commentKeys(disk)
	var out []Comment
	for i, k := range dk {
		if !slices.Contains(bk, k) || slices.Contains(ck, k) {
			out = append(out, disk[i])
		}
	}
	for i, k := range ck {
		if !slices.Contains(dk, k) && !slices.Contains(bk, k) {
			out = append(out, client[i])
		}
	}
	return out
}

// commentKeys numbers repeats like index does, so two identical comments
// stay two and deleting one deletes one.
func commentKeys(cs []Comment) []string {
	seen := map[string]int{}
	keys := make([]string, len(cs))
	for i, c := range cs {
		keys[i] = key(c.Author+"\x00"+c.Time+"\x00"+c.Text, seen)
	}
	return keys
}

func pick(client, base, disk string) string {
	if client != base {
		return client
	}
	return disk
}

type boardIndex struct {
	cols  []string            // column keys in order
	title map[string]string   // column key → title
	cards map[string][]string // column key → card keys in order
	keys  []string            // all card keys in reading order
	col   map[string]string   // card key → column key
	card  map[string]Card
}

func index(b Board) boardIndex {
	ix := boardIndex{title: map[string]string{}, cards: map[string][]string{}, col: map[string]string{}, card: map[string]Card{}}
	seenCol := map[string]int{}
	for _, col := range b.Columns {
		ck := key(col.Title, seenCol)
		ix.cols = append(ix.cols, ck)
		ix.title[ck] = col.Title
		for _, c := range col.Cards {
			k := c.ID
			ix.keys = append(ix.keys, k)
			ix.cards[ck] = append(ix.cards[ck], k)
			ix.col[k] = ck
			ix.card[k] = c
		}
	}
	return ix
}

func key(title string, seen map[string]int) string {
	n := seen[title]
	seen[title] = n + 1
	return fmt.Sprintf("%s\x00%d", title, n)
}
