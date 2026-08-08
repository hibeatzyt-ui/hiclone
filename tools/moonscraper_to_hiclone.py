#!/usr/bin/env python3
"""
moonscraper_to_hiclone.py — convert a Moonscraper / Clone Hero .chart file
into a Hi Clone chart.chart (+ starter info.json).

Mapping (frets -> Hi Clone lanes 1-4):
    fret 0 (green)  -> lane 1
    fret 1 (red)    -> lane 2
    fret 2 (yellow) -> lane 3
    fret 3 (blue)   -> lane 4
    fret 4 (orange) -> DROPPED (Hi Clone only has 4 lanes)
    fret 5 (forced) -> ignored (no HOPO concept in Hi Clone)
    fret 6 (tap)    -> ignored (no tap-note concept in Hi Clone)
    fret 7 (open)   -> DROPPED, with a warning (nothing sensible to map it to)

Any N note with a sustain (length > 0) becomes a hold. Swipe/noodle info
comes from E events (in the global [Events] section and/or inline in the
difficulty section):

  - Swipe events are self-contained: "r2" means swipe right, lane 2 —
    the digit IS the lane, not a magnitude. No note-pairing needed.
  - A sustain with no events inside it becomes one plain same-lane hold
    ("h2>2") for its full length.
  - A sustain with hA>B events inside it becomes a *chain* of holds: the
    rail starts at the sustain's own lane, then switches to whatever the
    next event says at that event's tick, staying there until the next
    event (or the sustain's own end). Duplicate consecutive same-code
    events just produce two adjacent segments of the same type — harmless.

USAGE
    python3 moonscraper_to_hiclone.py song.chart \
        --section ExpertSingle \
        --difficulty Diamond \
        --out "Hi Beatz/mysong_DIAMOND"

    # convert every difficulty found in one go:
    python3 moonscraper_to_hiclone.py song.chart --all --out-root "Hi Beatz" --slug mysong

Run with -h for full options.
"""

import argparse
import json
import os
import re
import sys

FRET_TO_LANE = {0: 1, 1: 2, 2: 3, 3: 4}   # 0-indexed fret -> 1-indexed Hi Clone lane
DROPPED_FRETS = {4, 7}                     # orange, open — no lane to map to
IGNORED_MODIFIER_FRETS = {5, 6}            # forced / tap flags — not real notes

# source .chart difficulty -> sensible default Hi Clone difficulty
DEFAULT_DIFF_MAP = {
    "Expert": "Diamond",
    "Hard": "Gold",
    "Medium": "Standard",
    "Easy": "Standard",
}

SECTION_RE = re.compile(r'^\[(.+?)\]\s*$')
LINE_RE = re.compile(r'^\s*(\d+)\s*=\s*(.+?)\s*$')


def parse_chart_sections(path):
    """Split a .chart file into {section_name: [raw_lines]}."""
    sections = {}
    current = None
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        for raw in f:
            line = raw.strip()
            if not line or line in ('{', '}'):
                continue
            m = SECTION_RE.match(line)
            if m:
                current = m.group(1)
                sections[current] = []
                continue
            if current is not None:
                sections[current].append(line)
    return sections


def parse_song_meta(lines):
    meta = {"Resolution": 192, "Offset": 0.0, "Name": None, "Artist": None}
    for line in lines:
        if '=' not in line:
            continue
        key, _, val = line.partition('=')
        key = key.strip()
        val = val.strip().strip('"')
        if key == "Resolution":
            meta["Resolution"] = int(val)
        elif key == "Offset":
            meta["Offset"] = float(val)
        elif key == "Name":
            meta["Name"] = val
        elif key == "Artist":
            meta["Artist"] = val
    return meta


def parse_sync_track(lines):
    """Returns sorted list of (tick, bpm) tempo changes. bpm values are
    stored in .chart as bpm*1000 (e.g. 120000 = 120.000 BPM)."""
    tempos = []
    for line in lines:
        m = LINE_RE.match(line)
        if not m:
            continue
        tick = int(m.group(1))
        rest = m.group(2).split()
        if not rest:
            continue
        if rest[0] == 'B' and len(rest) >= 2:
            bpm = int(rest[1]) / 1000.0
            tempos.append((tick, bpm))
    tempos.sort(key=lambda x: x[0])
    if not tempos or tempos[0][0] != 0:
        tempos.insert(0, (0, 120.0))  # .chart default if none specified at tick 0
    return tempos


def build_tick_to_seconds(tempos, resolution):
    """Returns a function tick -> seconds, tempo-map aware."""
    # precompute cumulative seconds at each tempo-change tick
    cum = []
    acc_seconds = 0.0
    for i, (tick, bpm) in enumerate(tempos):
        cum.append((tick, acc_seconds, bpm))
        if i + 1 < len(tempos):
            next_tick = tempos[i + 1][0]
            seconds_per_tick = 60.0 / (bpm * resolution)
            acc_seconds += (next_tick - tick) * seconds_per_tick

    def tick_to_seconds(tick):
        # find the last tempo segment at or before this tick
        seg = cum[0]
        for entry in cum:
            if entry[0] <= tick:
                seg = entry
            else:
                break
        seg_tick, seg_seconds, bpm = seg
        seconds_per_tick = 60.0 / (bpm * resolution)
        return seg_seconds + (tick - seg_tick) * seconds_per_tick

    return tick_to_seconds


SWIPE_CODE_RE = re.compile(r'^([lr])([1-4])$')
HOLD_EVENT_RE = re.compile(r'^h(\d)>(\d)$')
DEFAULT_NOODLE_DUR = 0.5  # fallback for an orphan hA>B event outside any sustain


def parse_events(lines):
    """Returns {tick: [event_text, ...]} from an [Events] section (or any
    section — global and per-difficulty events are merged by the caller).
    Assumes lines look like `<tick> = E "text"` (quotes optional)."""
    events = {}
    for line in lines:
        m = LINE_RE.match(line)
        if not m:
            continue
        tick = int(m.group(1))
        rest = m.group(2).strip()
        if not rest.startswith('E'):
            continue
        text = rest[1:].strip().strip('"').strip()
        if not text:
            continue
        events.setdefault(tick, []).append(text)
    return events


def parse_notes(lines, events_by_tick, tick_to_seconds, offset_seconds):
    """Returns (notes, warnings) — notes is a list of Hi Clone note dicts.

    - Swipe events ("l1".."l4"/"r1".."r4") are self-contained: the digit is
      the lane, the letter is the direction. Always become a swipe note.
    - hA>B events inside a sustain's tick range chain together into
      consecutive hold segments: the rail holds at the sustain's own lane
      until the first event, then at each event's lane until the next
      event (or the sustain's end).
    - A sustain with no hA>B events inside it is just one same-lane hold.
    - An hA>B event with no covering sustain still becomes a hold, with a
      default duration (and a warning, since there's nothing to time it by).
    """
    raw_notes = []  # (tick, fret, length_ticks)
    warnings = []

    for line in lines:
        m = LINE_RE.match(line)
        if not m:
            continue
        tick = int(m.group(1))
        rest = m.group(2).split()
        if not rest:
            continue
        if rest[0] != 'N' or len(rest) < 3:
            continue  # skip S (star power), E (events, handled separately), etc.
        fret = int(rest[1])
        length_ticks = int(rest[2])

        if fret in IGNORED_MODIFIER_FRETS:
            continue
        if fret in DROPPED_FRETS:
            if fret == 7:
                warnings.append(f"tick {tick}: open note dropped (no lane to map it to)")
            continue
        if fret not in FRET_TO_LANE:
            warnings.append(f"tick {tick}: unrecognized fret {fret}, skipped")
            continue

        raw_notes.append((tick, fret, length_ticks))

    notes = []
    consumed_hold_ticks = set()  # hA>B event ticks used up by a sustain's chain

    # --- 1. swipes: fully self-contained, independent of any note ---
    swiped_lane_at_tick = {}  # tick -> set of lanes already covered by a swipe here
    for tick, texts in events_by_tick.items():
        for text in texts:
            m = SWIPE_CODE_RE.match(text)
            if m:
                lane = int(m.group(2))
                t = round(tick_to_seconds(tick) + offset_seconds, 4)
                notes.append({"t": t, "lane": lane, "type": text})
                swiped_lane_at_tick.setdefault(tick, set()).add(lane)

    # --- 2. sustains: plain holds, or hA>B chains if events fall inside them ---
    for tick, fret, length_ticks in raw_notes:
        if length_ticks <= 0:
            continue
        lane = FRET_TO_LANE[fret]
        start_tick, end_tick = tick, tick + length_ticks

        inside = []
        for etick, texts in events_by_tick.items():
            if start_tick < etick <= end_tick:
                for text in texts:
                    if HOLD_EVENT_RE.match(text):
                        inside.append((etick, text))
        inside.sort(key=lambda x: x[0])

        if not inside:
            t = round(tick_to_seconds(start_tick) + offset_seconds, 4)
            dur = round(tick_to_seconds(end_tick) - tick_to_seconds(start_tick), 4)
            notes.append({"t": t, "type": f"h{lane}>{lane}", "dur": dur})
            continue

        boundaries = [start_tick] + [e[0] for e in inside]
        if boundaries[-1] < end_tick:
            boundaries.append(end_tick)

        for i in range(len(boundaries) - 1):
            seg_start, seg_end = boundaries[i], boundaries[i + 1]
            if seg_end <= seg_start:
                continue
            seg_type = f"h{lane}>{lane}" if i == 0 else inside[i - 1][1]
            t = round(tick_to_seconds(seg_start) + offset_seconds, 4)
            dur = round(tick_to_seconds(seg_end) - tick_to_seconds(seg_start), 4)
            notes.append({"t": t, "type": seg_type, "dur": dur})

        for etick, _ in inside:
            consumed_hold_ticks.add(etick)

    # --- 3. orphan hA>B events (no covering sustain) ---
    for tick, texts in events_by_tick.items():
        if tick in consumed_hold_ticks:
            continue
        for text in texts:
            if HOLD_EVENT_RE.match(text):
                t = round(tick_to_seconds(tick) + offset_seconds, 4)
                notes.append({"t": t, "type": text, "dur": DEFAULT_NOODLE_DUR})
                warnings.append(f"tick {tick}: noodle event {text} has no covering sustain — "
                                 f"used default {DEFAULT_NOODLE_DUR}s duration, check by hand")

    # --- 4. plain taps: N notes with no sustain, unless a swipe at the same
    #        tick + lane already covers this hit (Moonscraper needs a real
    #        note to anchor an event to, so that note isn't a second hit)
    for tick, fret, length_ticks in raw_notes:
        if length_ticks > 0:
            continue
        lane = FRET_TO_LANE[fret]
        if lane in swiped_lane_at_tick.get(tick, ()):
            continue
        t = round(tick_to_seconds(tick) + offset_seconds, 4)
        notes.append({"t": t, "lane": lane, "type": "tap"})

    notes.sort(key=lambda n: n["t"])
    return notes, warnings


def convert(chart_path, section_name, out_dir, bpm_hint=None):
    sections = parse_chart_sections(chart_path)

    if "Song" not in sections:
        sys.exit("No [Song] section found — is this a valid .chart file?")
    if section_name not in sections:
        available = [s for s in sections if s not in ("Song", "SyncTrack", "Events")]
        sys.exit(f"Section [{section_name}] not found. Available note sections: {available}")

    meta = parse_song_meta(sections["Song"])
    tempos = parse_sync_track(sections.get("SyncTrack", []))
    tick_to_seconds = build_tick_to_seconds(tempos, meta["Resolution"])

    # swipe/noodle events can live in the global [Events] section and/or be
    # mixed inline within the difficulty section itself — read both and merge
    events_by_tick = {}
    for src_lines in (sections.get("Events", []), sections[section_name]):
        for tick, texts in parse_events(src_lines).items():
            events_by_tick.setdefault(tick, []).extend(texts)

    notes, warnings = parse_notes(sections[section_name], events_by_tick, tick_to_seconds, meta["Offset"])

    os.makedirs(out_dir, exist_ok=True)

    chart_out = {
        "bpm": round(tempos[0][1], 3),
        "offset": 0,
        "notes": notes
    }
    chart_path_out = os.path.join(out_dir, "chart.chart")
    with open(chart_path_out, 'w') as f:
        json.dump(chart_out, f, indent=2)

    info_path_out = os.path.join(out_dir, "info.json")
    if not os.path.exists(info_path_out):
        info_out = {
            "title": meta["Name"] or "Untitled",
            "artist": meta["Artist"] or "Unknown Artist",
            "difficulty": "Standard",
            "bpm": round(tempos[0][1], 3),
            "audio": "audio.mp3",
            "artwork": "artwork.jpg",
            "chart": "chart.chart"
        }
        with open(info_path_out, 'w') as f:
            json.dump(info_out, f, indent=2)
        print(f"  wrote {info_path_out} (edit difficulty/title as needed, add audio.mp3 + artwork.jpg)")
    else:
        print(f"  {info_path_out} already exists, left untouched")

    print(f"  wrote {chart_path_out} ({len(notes)} notes)")
    for w in warnings:
        print(f"  [warning] {w}")

    return chart_path_out, info_path_out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("chart_file", help="path to the Moonscraper/.chart file")
    p.add_argument("--instrument", default="Single", help="instrument track, e.g. Single, DoubleGuitar, Drums (default: Single)")
    p.add_argument("--section", help="exact section name to convert, e.g. ExpertSingle (overrides --difficulty/--instrument)")
    p.add_argument("--difficulty", choices=["Expert", "Hard", "Medium", "Easy"], help="source difficulty to convert")
    p.add_argument("--out", help="output folder for a single conversion, e.g. \"Hi Beatz/mysong_DIAMOND\"")
    p.add_argument("--all", action="store_true", help="convert every Expert/Hard/Medium/Easy section found for --instrument")
    p.add_argument("--out-root", default="Hi Beatz", help="root folder for --all mode (default: \"Hi Beatz\")")
    p.add_argument("--slug", help="song slug for --all mode folder names, e.g. \"mysong\" -> mysong_ST / mysong_GOLD / mysong_DIAMOND")
    args = p.parse_args()

    if args.all:
        if not args.slug:
            sys.exit("--all requires --slug, e.g. --slug mysong")
        sections = parse_chart_sections(args.chart_file)
        diff_code = {"Standard": "ST", "Gold": "GOLD", "Diamond": "DIAMOND"}
        made_any = False
        for src_diff, hc_diff in DEFAULT_DIFF_MAP.items():
            section_name = f"{src_diff}{args.instrument}"
            if section_name not in sections:
                continue
            out_dir = os.path.join(args.out_root, f"{args.slug}_{diff_code[hc_diff]}")
            print(f"[{section_name}] -> {out_dir}  (Hi Clone difficulty: {hc_diff})")
            _, info_path = convert(args.chart_file, section_name, out_dir)
            with open(info_path) as f:
                info = json.load(f)
            info["difficulty"] = hc_diff
            with open(info_path, 'w') as f:
                json.dump(info, f, indent=2)
            made_any = True
        if not made_any:
            sys.exit(f"No {args.instrument} sections found in this file.")
        print("\nDon't forget: add the new folder name(s) to Hi Beatz/songs.json,")
        print("and drop in audio.mp3 + artwork.jpg for each folder.")
        return

    section_name = args.section
    if not section_name:
        if not args.difficulty:
            sys.exit("Provide --section NAME, or --difficulty (Expert/Hard/Medium/Easy), or use --all.")
        section_name = f"{args.difficulty}{args.instrument}"

    out_dir = args.out
    if not out_dir:
        sys.exit("Provide --out \"Hi Beatz/yourfolder_DIFF\" (or use --all for automatic folder names).")

    print(f"[{section_name}] -> {out_dir}")
    convert(args.chart_file, section_name, out_dir)
    print("\nDon't forget: add the folder name to Hi Beatz/songs.json,")
    print("and drop in audio.mp3 + artwork.jpg.")


if __name__ == "__main__":
    main()
