package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
)

// unreadable is a file Parse rejects. It is never written: whoever broke it
// fixes it, and kban shows them the line.
type unreadable struct{ error }

// update applies change to the board as it is on disk now. A browser save
// and a command can land at any moment, so a file that changed between the
// read and the rename is read and changed again rather than overwritten.
// It returns the file as it now is.
func update(path string, change func(*Board) error) (string, error) {
	for range 20 {
		src, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		b, err := Parse(string(src))
		if err != nil {
			return "", unreadable{err}
		}
		was := Write(b)
		if err := change(&b); err != nil {
			return "", err
		}
		out := Write(b)
		if out == was {
			return string(src), nil
		}
		if ok, err := replace(path, src, out); ok || err != nil {
			return out, err
		}
	}
	return "", errors.New("the file kept changing while kban wrote it; nothing written")
}

// beforeRename lets a test land a write between the read and the rename.
var beforeRename = func() {}

// replace writes out to path if path still holds was. Writes are atomic
// (temp file + rename): an agent reading the file never sees half a board.
// ponytail: a write landing between the compare and the rename is still lost; a cross-process lock (flock, LockFileEx on Windows) if that bites.
func replace(path string, was []byte, out string) (bool, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return false, err
	}
	defer os.Remove(f.Name()) // gone already after the rename
	_, err = f.WriteString(out)
	if err == nil {
		err = f.Chmod(fi.Mode().Perm())
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return false, err
	}
	beforeRename()
	now, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(now, was) {
		return false, err
	}
	return true, os.Rename(f.Name(), path)
}
