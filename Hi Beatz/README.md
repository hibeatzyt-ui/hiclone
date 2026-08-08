# Hi Beatz — your song library

This folder *is* your library. Hi Clone reads it entirely from static files —
there's no server, no database, nothing to install. Every song is one folder
in here, and `songs.json` (in this folder) lists which folders to load.

## 1. Folder naming

```
Hi Beatz/
  7rings_ST/
  7rings_DIAMOND/
  shapeofyou_GOLD/
```

Pattern: `<anything>_<DIFFCODE>`, where `<DIFFCODE>` is one of:

| Suffix     | Shown as  |
|------------|-----------|
| `_ST`      | Standard  |
| `_GOLD`    | Gold      |
| `_DIAMOND` | Diamond   |

Songs are grouped in-game by their `title` + `artist` (from `info.json`), so
`7rings_ST` and `7rings_DIAMOND` show up as one song card in Song Select with
two selectable difficulties. The folder suffix is just a naming convention —
if `info.json` includes an explicit `"difficulty"` field, that wins.

## 2. What goes inside each song folder

```
7rings_DIAMOND/
  info.json      required
  chart.chart    required
  audio.mp3      required (mp3/ogg/wav all work — just match the "audio" field)
  artwork.jpg    optional but recommended (jpg/png)
```

A ready-to-copy starting point is in `Hi Beatz/_template/`.

## 3. info.json

```json
{
  "title": "7 rings",
  "artist": "Ariana Grande",
  "difficulty": "Diamond",
  "bpm": 140,
  "audio": "audio.mp3",
  "artwork": "artwork.jpg",
  "chart": "chart.chart"
}
```

Don't want to hand-write this? Open Hi Clone → **Add a Song** on the home
screen. Fill in the title, artist, difficulty and BPM, and it generates this
JSON for you (and shows you the folder name to create).

## 4. chart.chart — note types

The file is plain JSON with a `.chart` extension (to match your other chart
tooling) — the content format is exactly the same as `.json`, just saved
with a different name.

```json
{
  "bpm": 120,
  "offset": 0,
  "notes": [ ... ]
}
```

- `bpm` — informational / used for authoring.
- `offset` — seconds to shift every note relative to the audio file, in case
  your export has lead-in silence.
- `notes` — an array of note objects, each with a `t` (time in seconds from
  the start of the audio) and a `type`:

| type              | meaning                                             | required fields |
|-------------------|------------------------------------------------------|------------------|
| `"tap"`           | plain tap note                                       | `lane` (1–4)     |
| `"l1"`,`"l2"`,`"l3"`,`"l4"` | swipe **left** across 1–4 lanes, starting at `lane`  | `lane` (1–4)     |
| `"r1"`,`"r2"`,`"r3"`,`"r4"` | swipe **right** across 1–4 lanes, starting at `lane` | `lane` (1–4)     |
| `"h<a>><b>"` e.g. `"h2>3"`, `"h3>4"` | noodle hold — press-and-hold lane `a`, dragged to lane `b` | `dur` (seconds) |

Example:

```json
{ "t": 1.50, "lane": 2, "type": "tap" }
{ "t": 3.50, "lane": 1, "type": "l1" }
{ "t": 4.00, "lane": 4, "type": "r4" }
{ "t": 5.00, "type": "h2>3", "dur": 0.6 }
{ "t": 6.00, "type": "h3>4", "dur": 0.6 }
```

Notes must be listed in any order — Hi Clone sorts them by time on load.

## 5. Adding the song to your library

Open `Hi Beatz/songs.json` and add the folder name to the array:

```json
["7rings_ST", "7rings_DIAMOND", "shapeofyou_GOLD"]
```

That's it — reload Hi Clone and the song shows up in Song Select.

## 7. Converting from Moonscraper (.chart guitar files)

If you already have charts made in Moonscraper (5-fret guitar `.chart`
files), there's a converter that turns them straight into Hi Clone's format
— no manual re-charting.

**No Python installed?** Open `tools/moonscraper-converter.html` in any
browser (double-click it, no server needed) — it's a self-contained page
that does the whole conversion client-side. Drop your `.chart` file in, pick
the note section and target difficulty, and download `chart.chart` +
`info.json` directly.

**Have Python?** `tools/moonscraper_to_hiclone.py` does the same conversion
from the command line and can write straight into your `Hi Beatz` folder
instead of downloading — see below.

**Taps and holds** come from the note (`N`) lines: frets 0–3
(green/red/yellow/blue) → lanes 1–4, fret 4 (orange) is dropped (only 4
lanes here). Any note with a sustain (`N 0 271`) becomes a hold.

**Swipes and noodle wiggles** come from `E` events, in either the global
`[Events]` section or inline in the difficulty section:
- `E "l2"` / `E "r3"` etc. is a fully self-contained swipe — the digit
  *is* the lane, the letter is the direction. It doesn't need a companion
  note; if one happens to sit at the same tick (Moonscraper needs a real
  note to anchor an event to), that note is treated as already covered by
  the swipe rather than counted twice.
- A plain sustain with no events inside it becomes one same-lane hold for
  its full length.
- A sustain with `hA>B` events inside it becomes a **chain** of holds: the
  rail starts at the sustain's own lane, switches to whatever the next
  event says at that event's tick, and stays there until the next event
  (or the sustain's own end). Two consecutive events with the same code
  just produce two adjacent segments of that type — harmless.

Convert one difficulty. Since your workflow charts every difficulty in
`ExpertSingle` (one physical `.chart` file per Hi Clone difficulty, rather
than using Moonscraper's Hard/Medium/Easy tiers), point `--out` at whichever
difficulty folder this particular file is for:

```bash
python3 tools/moonscraper_to_hiclone.py song.chart \
  --difficulty Expert \
  --out "Hi Beatz/mysong_DIAMOND"
```

You'll have one `.chart` file per Hi Clone difficulty (e.g. a
`_ST`/`_GOLD`/`_DIAMOND` version of the same song), each internally using
`ExpertSingle` — so run the command once per file, pointing `--out` at the
matching folder each time:

```bash
python3 tools/moonscraper_to_hiclone.py mysong_standard.chart --difficulty Expert --out "Hi Beatz/mysong_ST"
python3 tools/moonscraper_to_hiclone.py mysong_gold.chart     --difficulty Expert --out "Hi Beatz/mysong_GOLD"
python3 tools/moonscraper_to_hiclone.py mysong_diamond.chart  --difficulty Expert --out "Hi Beatz/mysong_DIAMOND"
```

(There's also a `--all` flag that maps Moonscraper's Expert/Hard/Medium/Easy
tiers within a *single* file to Diamond/Gold/Standard — only useful if you
ever chart that way instead; run with `-h` to see it.)

Either way it writes `chart.chart` plus a starter `info.json` (title/artist
pulled from the `.chart` file's `Name`/`Artist` fields when present). You
still need to drop in `audio.mp3` + `artwork.jpg` yourself and add the new
folder(s) to `Hi Beatz/songs.json`. Run with `-h` for all options (custom
section names, other instrument tracks like `Drums`, etc.).

## 8. A note on audio files

Hi Clone doesn't ship with any songs. Add your own audio files locally —
just make sure you have the right to use whatever you put in here, especially
if you publish your GitHub Pages site.

