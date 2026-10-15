package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
)

var commands = map[string]string{
	"show":    "[ID]",
	"add":     "COLUMN TITLE",
	"move":    "ID COLUMN",
	"set":     "ID title|notes TEXT",
	"comment": "ID TEXT",
}

// Agents change the board only through these, so every card keeps its id,
// and a browser save landing during a command keeps both changes. Exit 1 is a usage or lookup error,
// 2 a file kban cannot read; neither writes the file.
func cli(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	name, args := args[0], args[1:]
	fl := flag.NewFlagSet("kban "+name, flag.ContinueOnError)
	fl.SetOutput(stderr)
	file := fl.String("f", "TODO.json", "the board file")
	author := "agent"
	if name == "comment" {
		fl.StringVar(&author, "a", author, "the comment's author")
	}
	fl.Usage = func() {
		fmt.Fprintf(stderr, "usage: kban %s [flags] %s\nTEXT - reads stdin.\n", name, commands[name])
		fl.PrintDefaults()
	}
	if fl.Parse(args) != nil {
		return 1
	}
	a := fl.Args()
	if n := len(a); n != len(strings.Fields(commands[name])) && !(name == "show" && n == 0) {
		fl.Usage()
		return 1
	}
	fail := func(err error) int {
		fmt.Fprintln(stderr, "kban:", err)
		if errors.As(err, new(unreadable)) {
			return 2
		}
		return 1
	}
	text := ""
	if name != "show" && name != "move" {
		text = a[len(a)-1]
		if text == "-" {
			in, err := io.ReadAll(stdin)
			if err != nil {
				return fail(err)
			}
			text = strings.TrimSuffix(string(in), "\n") // the one echo and heredocs add
		}
	}
	if name == "comment" {
		text = strings.TrimSpace(text) // as the browser posts it
	}
	if name == "set" && a[1] != "title" && a[1] != "notes" {
		return fail(fmt.Errorf("a card has no field %q: set title or notes", a[1]))
	}
	if strings.TrimSpace(text) == "" && (name == "add" || name == "comment" || name == "set" && a[1] == "title") {
		return fail(errors.New("TEXT is empty"))
	}

	// show changes nothing, so update reads the board and writes nothing.
	var shown Board
	id := newID()
	_, err := update(*file, func(b *Board) error {
		if name == "show" {
			shown = *b
			return nil
		}
		if name == "add" {
			to, err := column(b, a[0])
			if err != nil {
				return err
			}
			b.Columns[to].Cards = append(b.Columns[to].Cards, Card{ID: id, Title: text})
			return nil
		}
		c, i, err := find(b, a[0])
		if err != nil {
			return err
		}
		card := &b.Columns[c].Cards[i]
		switch name {
		case "move":
			to, err := column(b, a[1])
			if err != nil {
				return err
			}
			moved := *card
			b.Columns[c].Cards = slices.Delete(b.Columns[c].Cards, i, i+1)
			b.Columns[to].Cards = append(b.Columns[to].Cards, moved)
		case "set":
			if a[1] == "title" {
				card.Title = text
			} else {
				card.Notes = text
			}
		case "comment":
			card.Comments = append(card.Comments, Comment{author, time.Now().Format("2006-01-02T15:04:05-07:00"), text})
		}
		return nil
	})
	if err != nil {
		return fail(err)
	}
	switch {
	case name == "add":
		fmt.Fprintln(stdout, id)
	case name == "show" && len(a) == 0:
		io.WriteString(stdout, Write(shown))
	case name == "show":
		c, i, err := find(&shown, a[0])
		if err != nil {
			return fail(err)
		}
		enc := json.NewEncoder(stdout)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		enc.Encode(struct {
			Column string `json:"column"`
			Card
		}{shown.Columns[c].Title, shown.Columns[c].Cards[i]})
	}
	return 0
}

func find(b *Board, id string) (int, int, error) {
	for c, col := range b.Columns {
		for i, card := range col.Cards {
			if card.ID == id {
				return c, i, nil
			}
		}
	}
	return 0, 0, fmt.Errorf("no card has the id %q: kban show prints each card's id", id)
}

func column(b *Board, title string) (int, error) {
	var titles []string
	for c, col := range b.Columns {
		if col.Title == title {
			return c, nil
		}
		titles = append(titles, col.Title)
	}
	return 0, fmt.Errorf("no column %q; columns: %s", title, strings.Join(titles, ", "))
}
