package main

import (
	"fmt"
	"os"

	"randall/internal/config"
	"randall/internal/tray"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config load error: %v\n", err)
		os.Exit(1)
	}

	tray.Run(cfg)
}
