//go:build unix

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// startDetached starts this kban as the hub alone, in its own session with
// its stdio on /dev/null, so it outlives the terminal.
func startDetached(port int) (*os.Process, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "-p", fmt.Sprint(port))
	cmd.Env = append(os.Environ(), childEnv+"=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd.Process, nil
}
