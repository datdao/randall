package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

// Randall head at 32x32 resolution, multi-color layers.
// Each character maps to a color in the palette.
var randallMap = [32]string{
	"________________________________",
	"________________________________",
	"___________cc___________________",
	"__________cccc__________________",
	"_________cccccc_________________",
	"________cccccccc________________",
	"_______ccddddcccc______________",
	"______ddddddddddd______________",
	"_____ddddddddddddd_____________",
	"____ddddddddddddddd____________",
	"___dddddddddddddddddd__________",
	"__ddddddddddddddddddd__________",
	"__ddddwwdddddddddddddd_________",
	"_dddddwgddddddddddddddd________",
	"_dddddgpgddddddddddddddd_______",
	"_dddddwgdddddddddddddddd_______",
	"__ddddwwddddddddddddddddd______",
	"__ddddddddddddddddddddddd______",
	"___dddddddddddddddddddddddd____",
	"___ddddddddddddddddddddddddd___",
	"____ddddllldddddddddddddddddd__",
	"_____dddlllldddddddddddddddddd_",
	"______ddllllddddddddddddddddd__",
	"_______dlllddddddddddddddddd___",
	"________ddddddddddddddddddd____",
	"_________ddddddddddddddddd_____",
	"__________ddddddddddddddd______",
	"___________ddddddddddddd_______",
	"____________ddddddddddd________",
	"_____________ddddddddd_________",
	"______________ddddddd__________",
	"________________________________",
}

var palette = map[byte]color.RGBA{
	'_': {30, 30, 50, 255},    // background
	'd': {107, 47, 160, 255},  // body purple
	'c': {160, 50, 90, 255},   // crest dark magenta
	'l': {160, 110, 200, 255}, // belly lighter purple
	'w': {230, 230, 235, 255}, // eye white
	'g': {60, 200, 60, 255},   // iris green
	'p': {15, 15, 15, 255},    // pupil black
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: genicon <output-dir>")
		os.Exit(1)
	}
	outDir := os.Args[1]

	sizes := []struct {
		name string
		size int
	}{
		{"icon_16x16.png", 16},
		{"icon_16x16@2x.png", 32},
		{"icon_32x32.png", 32},
		{"icon_32x32@2x.png", 64},
		{"icon_128x128.png", 128},
		{"icon_128x128@2x.png", 256},
		{"icon_256x256.png", 256},
		{"icon_256x256@2x.png", 512},
		{"icon_512x512.png", 512},
		{"icon_512x512@2x.png", 1024},
	}

	iconsetDir := filepath.Join(outDir, "Randall.iconset")
	if err := os.MkdirAll(iconsetDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir: %v\n", err)
		os.Exit(1)
	}

	for _, s := range sizes {
		img := renderAppIcon(s.size)
		path := filepath.Join(iconsetDir, s.name)
		f, err := os.Create(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "create %s: %v\n", path, err)
			os.Exit(1)
		}
		if err := png.Encode(f, img); err != nil {
			f.Close()
			fmt.Fprintf(os.Stderr, "encode %s: %v\n", path, err)
			os.Exit(1)
		}
		f.Close()
	}
	fmt.Printf("Generated iconset at %s\n", iconsetDir)
}

func renderAppIcon(size int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	src := 32 // source bitmap size
	scale := float64(size) / float64(src)

	// Render scaled bitmap with anti-aliased sampling
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			// Sample the source bitmap
			sx := float64(x) / scale
			sy := float64(y) / scale
			c := sampleColor(sx, sy)

			// Apply rounded corners
			cornerR := float64(size) * 0.18
			if !inRoundedRect(float64(x), float64(y), float64(size), float64(size), cornerR) {
				c = color.RGBA{0, 0, 0, 0}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func sampleColor(sx, sy float64) color.RGBA {
	ix := int(sx)
	iy := int(sy)
	if iy < 0 || iy >= 32 || ix < 0 || ix >= 32 {
		return palette['_']
	}
	row := randallMap[iy]
	if ix >= len(row) {
		return palette['_']
	}
	ch := row[ix]
	if c, ok := palette[ch]; ok {
		return c
	}
	return palette['_']
}

func inRoundedRect(x, y, w, h, r float64) bool {
	// Check if point is inside rounded rectangle
	if x >= r && x <= w-r {
		return y >= 0 && y <= h
	}
	if y >= r && y <= h-r {
		return x >= 0 && x <= w
	}
	// Check corners
	corners := [][2]float64{
		{r, r},
		{w - r, r},
		{r, h - r},
		{w - r, h - r},
	}
	for _, c := range corners {
		dx := x - c[0]
		dy := y - c[1]
		if dx*dx+dy*dy <= r*r {
			return true
		}
		// Only check the relevant corner
		if (x < r || x > w-r) && (y < r || y > h-r) {
			nearX := c[0]
			nearY := c[1]
			if math.Abs(x-nearX) < r && math.Abs(y-nearY) < r {
				return dx*dx+dy*dy <= r*r
			}
		}
	}
	// Point is outside all corners
	if x < r && y < r {
		dx := x - r
		dy := y - r
		return dx*dx+dy*dy <= r*r
	}
	if x > w-r && y < r {
		dx := x - (w - r)
		dy := y - r
		return dx*dx+dy*dy <= r*r
	}
	if x < r && y > h-r {
		dx := x - r
		dy := y - (h - r)
		return dx*dx+dy*dy <= r*r
	}
	if x > w-r && y > h-r {
		dx := x - (w - r)
		dy := y - (h - r)
		return dx*dx+dy*dy <= r*r
	}
	return true
}
