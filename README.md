# Hi Clone

A 4-lane tap / swipe / noodle-hold rhythm game that runs entirely as static
files — built to be hosted on GitHub Pages, no server or backend required.

Songs live in the `Hi Beatz/` folder. See **`Hi Beatz/README.md`** for the
full song format (folder naming, `info.json`, `chart.chart` note syntax).

## Run it locally

Browsers block `fetch()` on `file://` pages, so you need a tiny local server
— just double-clicking `index.html` won't load your song library.

```bash
cd HiClone
python3 -m http.server 8000
# then open http://localhost:8000
```

(Any static server works — `npx serve`, VS Code's Live Server extension, etc.)

## Deploy to GitHub Pages

1. Create a new GitHub repo (or use an existing one) and push this whole
   `HiClone` folder to it — `index.html` should sit at the repo root (or in
   `/docs` if you'd rather point Pages there).

   ```bash
   git init
   git add .
   git commit -m "Hi Clone"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. On GitHub: **Settings → Pages → Build and deployment → Source** → *Deploy
   from a branch* → branch `main`, folder `/ (root)` → **Save**.

3. GitHub gives you a URL like `https://<you>.github.io/<repo>/` — that's your
   live game. It can take a minute or two after each push to update.

4. Add songs by committing new folders under `Hi Beatz/` (with `songs.json`
   updated) and pushing again.

## Controls

- **Keyboard:** `D F J K` = lanes 1–4. `←`/`→` arrows count as the swipe
  direction for swipe notes. Hold a lane key down through a noodle note.
- **Touch:** tap a lane strip for taps/holds; drag left or right across a
  lane strip to satisfy a swipe note.

## Local profile & scores

There's no real account system — GitHub Pages can't run a login server. The
**Profile** screen saves a name, avatar, and your high scores to this
browser's `localStorage`, on this device only.

## Settings

- **Scroll speed** — how fast notes fall, independent of song playback speed.
- **Audio sync** — a short calibration exercise that measures the delay
  between what you hear and when you tap, and applies it as an offset to
  note timing.
