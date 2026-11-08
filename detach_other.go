//go:build !unix

package main

import (
	"errors"
	"os"
)

func startDetached(args []string) (*os.Process, error) {
	return nil, errors.New("-d needs a Unix system")
}
