package tray

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
)

// Randall head silhouette (chameleon/lizard profile facing right), 22x22.
// 'X' = filled pixel, ' ' = transparent.
var randallBitmap = [22]string{
	"                      ", // 0
	"       XX             ", // 1  crest tip
	"      XXXX            ", // 2  crest
	"     XXXXXX           ", // 3
	"    XXXXXXXX          ", // 4
	"   XXXXXXXXXX         ", // 5
	"  XXXXXXXXXXXX        ", // 6
	" XXXXXX  XXXXXX       ", // 7  eye socket
	" XXXXX    XXXXX       ", // 8  eye
	" XXXXXX  XXXXXXX      ", // 9
	" XXXXXXXXXXXXXXXX     ", // 10
	"  XXXXXXXXXXXXXXXXX   ", // 11 snout
	"  XXXXXXXXXXXXXXXXXXX ", // 12
	"   XXXXXXXXXXXXXXXXXX ", // 13
	"    XXXXXXXXXXXXXXXXX ", // 14
	"     XXXXXXXXXXXXXXX  ", // 15
	"      XXXXXXXXXXXXX   ", // 16
	"       XXXXXXXXXX     ", // 17
	"        XXXXXXXX      ", // 18
	"         XXXXXX       ", // 19
	"          XXXX        ", // 20
	"                      ", // 21
}

// genIcon creates a 22x22 template-style PNG (Randall head silhouette).
func genIcon() []byte {
	return renderBitmap(color.RGBA{0, 0, 0, 255})
}

// genRecordingIcon creates a 22x22 red Randall head for active recording.
func genRecordingIcon() []byte {
	return renderBitmap(color.RGBA{220, 40, 40, 255})
}

func renderBitmap(c color.RGBA) []byte {
	const size = 22
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		row := randallBitmap[y]
		for x := 0; x < size && x < len(row); x++ {
			if row[x] == 'X' {
				img.Set(x, y, c)
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}
