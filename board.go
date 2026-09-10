package main

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

type Card struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type Column struct {
	Title string `json:"title"`
	Cards []Card `json:"cards"`
}

// Board is a markdown file: text before the first heading kept verbatim,
// each heading a column, each checkbox item a card, indented lines under a
// card its body. Checkbox state is derived: cards in the last column are [x].
type Board struct {
	Prelude string   `json:"prelude"`
	Columns []Column `json:"columns"`
}

var (
	headingRe  = regexp.MustCompile(`^#{1,6}\s+(.*?)\s*#*\s*$`)
	checkboxRe = regexp.MustCompile(`^[-*+] \[[ xX]\] ?(.*)$`)
)

func Parse(src string) Board {
	var b Board
	var prelude []string
	col, card := -1, -1
	for _, line := range strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n") {
		if m := headingRe.FindStringSubmatch(line); m != nil {
			b.Columns = append(b.Columns, Column{Title: m[1], Cards: []Card{}})
			col, card = len(b.Columns)-1, -1
			continue
		}
		if col < 0 {
			prelude = append(prelude, line)
			continue
		}
		cards := &b.Columns[col].Cards
		if m := checkboxRe.FindStringSubmatch(line); m != nil {
			*cards = append(*cards, Card{Title: strings.TrimSpace(m[1])})
			card = len(*cards) - 1
			continue
		}
		indented := strings.TrimLeft(line, " \t")
		if card >= 0 && (indented == "" || indented != line) {
			c := &(*cards)[card]
			c.Body += "\n" + strings.TrimRight(indented, " \t")
			continue
		}
		card = -1 // anything else ends the card and is dropped on write
	}
	for i := range b.Columns {
		for j := range b.Columns[i].Cards {
			c := &b.Columns[i].Cards[j]
			c.Body = strings.Trim(c.Body, "\n")
		}
	}
	b.Prelude = strings.Trim(strings.Join(prelude, "\n"), "\n")
	return b
}

func Write(b Board) string {
	var w strings.Builder
	if b.Prelude != "" {
		w.WriteString(b.Prelude + "\n\n")
	}
	for i, col := range b.Columns {
		if i > 0 {
			w.WriteString("\n")
		}
		fmt.Fprintf(&w, "# %s\n", col.Title)
		box := "[ ]"
		if i == len(b.Columns)-1 {
			box = "[x]"
		}
		for _, c := range col.Cards {
			fmt.Fprintf(&w, "- %s %s\n", box, c.Title)
			for _, line := range strings.Split(c.Body, "\n") {
				if line != "" {
					w.WriteString("  " + line + "\n")
				} else if c.Body != "" {
					w.WriteString("\n")
				}
			}
		}
	}
	return w.String()
}

// Merge reconciles concurrent edits. Each unit (prelude, column list, a
// card's body, a card's column, a column's card order) takes the client's
// value if the client changed it from base, otherwise disk's. Cards and
// columns are identified by title.
// ponytail: a card renamed on both sides becomes two cards; add hidden ids if that bites.
func Merge(base, client, disk Board) Board {
	if Write(client) == Write(base) {
		return disk
	}
	if Write(disk) == Write(base) {
		return client
	}
	b, c, d := index(base), index(client), index(disk)

	side := d
	if !slices.Equal(c.cols, b.cols) {
		side = c
	}
	out := Board{Prelude: pick(client.Prelude, base.Prelude, disk.Prelude)}
	slot := map[string]int{} // column key → index in out; unknown keys land in the first column
	for i, ck := range side.cols {
		out.Columns = append(out.Columns, Column{Title: side.title[ck]})
		slot[ck] = i
	}

	// Which cards survive, and in which column.
	var order []string
	where := map[string]int{}
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
		where[k] = slot[ck]
	}
	for _, k := range c.keys {
		_, inD := d.col[k]
		_, inB := b.col[k]
		if inD || inB {
			continue // already placed, or disk deleted
		}
		order = append(order, k)
		where[k] = slot[c.col[k]]
	}

	merged := func(k string) Card {
		cc, inC := c.card[k]
		bc, inB := b.card[k]
		dc, inD := d.card[k]
		if !inD || (inC && inB && cc.Body != bc.Body) {
			return cc
		}
		return dc
	}

	placed := map[string]bool{}
	for i := range out.Columns {
		ck := side.cols[i]
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

// index keys columns and cards by title, numbering repeats so duplicates
// stay distinct.
func index(b Board) boardIndex {
	ix := boardIndex{title: map[string]string{}, cards: map[string][]string{}, col: map[string]string{}, card: map[string]Card{}}
	seenCol, seenCard := map[string]int{}, map[string]int{}
	for _, col := range b.Columns {
		ck := key(col.Title, seenCol)
		ix.cols = append(ix.cols, ck)
		ix.title[ck] = col.Title
		for _, c := range col.Cards {
			k := key(c.Title, seenCard)
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
