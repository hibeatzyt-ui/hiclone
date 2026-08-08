// main.js — Hi Clone app shell
// Reads Hi Beatz/songs.json for a list of song folders, then reads each
// folder's info.json for metadata. See Hi Beatz/README.md for the full spec.

const LIBRARY_ROOT = 'Hi Beatz';
const DIFF_SUFFIX = { ST: 'Standard', GOLD: 'Gold', DIAMOND: 'Diamond' };
const DIFF_ORDER = ['Standard', 'Gold', 'Diamond'];

let songGroups = [];       // [{key, title, artist, artwork, entries:{Standard,Gold,Diamond}}]
let currentGroup = null;
let currentDifficulty = null;
let currentEntry = null;   // the chosen song entry object
let game = null;
let gameAudioEl = null;

// ---------------- navigation ----------------

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const target = nav.getAttribute('data-nav');
    if (target === 'home' && game) { game.stop(); game = null; }
    showScreen(target);
    if (target === 'profile') renderProfileScreen();
  }
});

// ---------------- library loading ----------------

function inferDifficulty(folder, info) {
  if (info.difficulty) return info.difficulty;
  const m = /_([A-Z]+)$/.exec(folder);
  if (m && DIFF_SUFFIX[m[1]]) return DIFF_SUFFIX[m[1]];
  return 'Standard';
}

async function loadLibrary() {
  const statusEl = document.getElementById('manifest-status');
  try {
    const res = await fetch(`${LIBRARY_ROOT}/songs.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error('no manifest');
    const folders = await res.json();

    const groupsMap = new Map();

    for (const folder of folders) {
      try {
        const infoRes = await fetch(`${LIBRARY_ROOT}/${folder}/info.json`, { cache: 'no-store' });
        if (!infoRes.ok) continue;
        const info = await infoRes.json();
        const difficulty = inferDifficulty(folder, info);
        const entry = {
          folder,
          title: info.title || folder,
          artist: info.artist || 'Unknown Artist',
          bpm: info.bpm || 120,
          difficulty,
          audio: `${LIBRARY_ROOT}/${folder}/${info.audio || 'audio.mp3'}`,
          artwork: `${LIBRARY_ROOT}/${folder}/${info.artwork || 'artwork.jpg'}`,
          chart: `${LIBRARY_ROOT}/${folder}/${info.chart || 'chart.chart'}`
        };
        const key = `${entry.title}|||${entry.artist}`;
        if (!groupsMap.has(key)) {
          groupsMap.set(key, { key, title: entry.title, artist: entry.artist, artwork: entry.artwork, entries: {} });
        }
        groupsMap.get(key).entries[difficulty] = entry;
      } catch (err) {
        console.warn('Could not load song folder', folder, err);
      }
    }

    songGroups = Array.from(groupsMap.values()).sort((a, b) => a.title.localeCompare(b.title));
    statusEl.textContent = songGroups.length
      ? `${songGroups.length} song${songGroups.length === 1 ? '' : 's'} loaded from Hi Beatz`
      : 'Your Hi Beatz folder is empty — add a song to get started.';
    renderSongList();
  } catch (err) {
    statusEl.textContent = 'Could not find Hi Beatz/songs.json — see the README to set up your library.';
    renderSongList();
  }
}

// ---------------- song select ----------------

function renderSongList() {
  const list = document.getElementById('song-list');
  list.innerHTML = '';

  if (!songGroups.length) {
    list.innerHTML = `<div class="empty-state">
      No songs found yet.<br><br>
      Create <code>Hi Beatz/&lt;song&gt;_ST</code> (or _GOLD / _DIAMOND) with
      <code>artwork</code>, <code>audio</code>, <code>chart.chart</code> and
      <code>info.json</code> inside, then list the folder in
      <code>Hi Beatz/songs.json</code>. Use "Add a Song" from the home screen
      to generate info.json.
    </div>`;
    return;
  }

  for (const group of songGroups) {
    const row = document.createElement('div');
    row.className = 'song-card';
    row.innerHTML = `
      <img src="${group.artwork}" alt="" onerror="this.style.opacity=0.15">
      <div class="song-meta">
        <div class="song-title">${escapeHtml(group.title)}</div>
        <div class="song-artist">${escapeHtml(group.artist)}</div>
      </div>
      <div class="diff-chips">
        ${DIFF_ORDER.filter(d => group.entries[d]).map(d => `<span class="diff-chip ${d}"></span>`).join('')}
      </div>
    `;
    row.addEventListener('click', () => openDifficultyScreen(group));
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openDifficultyScreen(group) {
  currentGroup = group;
  currentDifficulty = null;
  currentEntry = null;
  document.getElementById('diff-title').textContent = group.title;
  document.getElementById('diff-artist').textContent = group.artist;
  document.getElementById('diff-artwork').src = group.artwork;

  const listEl = document.getElementById('diff-chart-list');
  listEl.innerHTML = '';
  DIFF_ORDER.forEach(d => {
    const entry = group.entries[d];
    if (!entry) return;
    const best = Account.getBestScore(entry.folder);
    const row = document.createElement('div');
    row.className = `diff-row ${d}`;
    row.innerHTML = `
      <span class="diff-name">${d}</span>
      <span class="diff-best">${best ? best.grade + ' · ' + best.score : 'No score yet'}</span>
    `;
    row.addEventListener('click', () => {
      listEl.querySelectorAll('.diff-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      currentDifficulty = d;
      currentEntry = entry;
      const btn = document.getElementById('diff-play-btn');
      btn.disabled = false;
      btn.textContent = `Play ${d}`;
    });
    listEl.appendChild(row);
  });

  document.getElementById('diff-play-btn').disabled = true;
  document.getElementById('diff-play-btn').textContent = 'Select a difficulty';
  showScreen('difficulty');
}

document.getElementById('diff-play-btn').addEventListener('click', () => {
  if (currentEntry) startGame(currentEntry);
});

// ---------------- gameplay ----------------

async function startGame(entry) {
  showScreen('game');
  const canvas = document.getElementById('game-canvas');

  if (gameAudioEl) { gameAudioEl.pause(); gameAudioEl.remove(); }
  gameAudioEl = new Audio(entry.audio);
  gameAudioEl.preload = 'auto';

  let chartData;
  try {
    const res = await fetch(entry.chart, { cache: 'no-store' });
    chartData = await res.json();
  } catch (err) {
    alert('Could not load chart file for this song. Check chart.chart in ' + entry.folder);
    showScreen('difficulty');
    return;
  }

  const settings = Account.getSettings();

  document.getElementById('disc-title').textContent = entry.title;
  document.getElementById('disc-art-img').src = entry.artwork;

  game = new HiCloneGame(canvas, {
    audio: gameAudioEl,
    speed: settings.speed,
    audioOffsetMs: settings.audioOffsetMs,
    onScoreUpdate: (score, combo) => updateHud(score, combo),
    onJudgment: (tier, note) => flashJudgment(tier),
    onFinish: (results) => finishGame(entry, results)
  });
  game.load(chartData);

  updateHud(0, 0);
  document.getElementById('pause-overlay').classList.remove('active');
  document.getElementById('disc-ring').classList.add('playing');

  game.start();
}

function updateHud(score, combo) {
  document.getElementById('hud-score').textContent = score.toLocaleString();
  const arc = document.getElementById('combo-arc');
  const label = document.getElementById('hud-combo-label');
  label.textContent = `x ${combo}`;
  arc.classList.toggle('show', combo > 0);
}

function flashJudgment(tier) {
  const el = document.getElementById('judgment-flash');
  el.textContent = JUDGE[tier].label;
  el.style.color = JUDGE[tier].color;
  el.style.opacity = '1';
  el.style.transform = 'translate(-50%,-50%) scale(1.15)';
  clearTimeout(flashJudgment._t);
  flashJudgment._t = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%,-50%) scale(1)';
  }, 220);
}

function finishGame(entry, results) {
  document.getElementById('disc-ring').classList.remove('playing');
  laneTileEls.forEach(el => el.classList.remove('active'));
  Account.submitScore(entry.folder, results);
  document.getElementById('results-song').textContent = `${entry.title} — ${entry.difficulty}`;
  document.getElementById('results-grade').textContent = results.grade;
  document.getElementById('results-score').textContent = results.score;
  document.getElementById('res-perfect').textContent = results.counts.PERFECT;
  document.getElementById('res-great').textContent = results.counts.GREAT;
  document.getElementById('res-good').textContent = results.counts.GOOD;
  document.getElementById('res-miss').textContent = results.counts.MISS;
  document.getElementById('res-maxcombo').textContent = results.maxCombo;
  document.getElementById('res-accuracy').textContent = results.accuracy + '%';
  showScreen('results');
}

document.getElementById('results-retry').addEventListener('click', () => {
  if (currentEntry) startGame(currentEntry);
});

// pause / resume / quit
document.getElementById('pause-btn').addEventListener('click', () => {
  if (!game) return;
  game.pause();
  document.getElementById('disc-ring').classList.remove('playing');
  document.getElementById('pause-overlay').classList.add('active');
});
document.getElementById('resume-btn').addEventListener('click', () => {
  document.getElementById('pause-overlay').classList.remove('active');
  if (game) { game.resume(); document.getElementById('disc-ring').classList.add('playing'); }
});
document.getElementById('restart-btn').addEventListener('click', () => {
  document.getElementById('pause-overlay').classList.remove('active');
  if (currentEntry) startGame(currentEntry);
});
document.getElementById('quit-btn').addEventListener('click', () => {
  document.getElementById('pause-overlay').classList.remove('active');
  document.getElementById('disc-ring').classList.remove('playing');
  laneTileEls.forEach(el => el.classList.remove('active'));
  if (game) { game.stop(); game = null; }
  showScreen('songselect');
});

// ---------------- input: keyboard ----------------

const LANE_KEYS = { d: 0, f: 1, j: 2, k: 3 };
const laneTileEls = Array.from(document.querySelectorAll('.lane-tile'));
function setTileActive(lane, active) {
  const el = laneTileEls[lane];
  if (el) el.classList.toggle('active', active);
}

document.addEventListener('keydown', (e) => {
  if (!game || !game.running) return;
  const key = e.key.toLowerCase();
  if (key in LANE_KEYS) {
    if (!e.repeat) { game.handleLaneDown(LANE_KEYS[key]); setTileActive(LANE_KEYS[key], true); }
  } else if (e.key === 'ArrowLeft') {
    game.handleArrow('l');
  } else if (e.key === 'ArrowRight') {
    game.handleArrow('r');
  } else if (e.key === 'Escape') {
    document.getElementById('pause-btn').click();
  }
});
document.addEventListener('keyup', (e) => {
  if (!game) return;
  const key = e.key.toLowerCase();
  if (key in LANE_KEYS) { game.handleLaneUp(LANE_KEYS[key]); setTileActive(LANE_KEYS[key], false); }
});

// ---------------- input: touch ----------------

document.querySelectorAll('.touch-lane').forEach(el => {
  const lane = parseInt(el.dataset.lane, 10);
  let startX = null;

  el.addEventListener('pointerdown', (e) => {
    if (!game || !game.running) return;
    startX = e.clientX;
    game.handleLaneDown(lane);
    setTileActive(lane, true);
  });
  el.addEventListener('pointerup', (e) => {
    if (!game) return;
    if (startX !== null) {
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 28) game.handleArrow(dx > 0 ? 'r' : 'l');
      // re-check swipe judgment right after direction is known
      game.handleLaneDown(lane);
    }
    game.handleLaneUp(lane);
    setTileActive(lane, false);
    startX = null;
  });
  el.addEventListener('pointercancel', () => { if (game) game.handleLaneUp(lane); setTileActive(lane, false); startX = null; });
});

// ---------------- settings ----------------

function initSettingsScreen() {
  const settings = Account.getSettings();
  const slider = document.getElementById('speed-slider');
  const valueEl = document.getElementById('speed-value');
  slider.value = settings.speed;
  valueEl.textContent = settings.speed.toFixed(1) + '×';
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valueEl.textContent = v.toFixed(1) + '×';
    const s = Account.getSettings();
    s.speed = v;
    Account.saveSettings(s);
    if (game) game.setSpeed(v);
  });

  document.getElementById('sync-offset-display').textContent = settings.audioOffsetMs + ' ms';
}

// audio sync calibration: play clicks, capture taps, average the offset
let syncCtx = null, syncTimer = null, syncTaps = [], syncBeatTimes = [];
document.getElementById('sync-start-btn').addEventListener('click', () => {
  if (syncTimer) { stopSync(); return; }
  startSync();
});

function startSync() {
  syncCtx = new (window.AudioContext || window.webkitAudioContext)();
  syncTaps = [];
  syncBeatTimes = [];
  const bpm = 100;
  const interval = 60 / bpm;
  const startAt = syncCtx.currentTime + 0.3;
  const pulseEl = document.getElementById('sync-pulse');
  document.getElementById('sync-start-btn').textContent = 'Stop (tap SPACE on the beat)';

  let beat = 0;
  const maxBeats = 12;

  function scheduleBeat() {
    if (beat >= maxBeats) { stopSync(); return; }
    const when = startAt + beat * interval;
    const osc = syncCtx.createOscillator();
    const gain = syncCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
    osc.connect(gain).connect(syncCtx.destination);
    osc.start(when);
    osc.stop(when + 0.1);
    syncBeatTimes.push(when);

    const delay = (when - syncCtx.currentTime) * 1000;
    setTimeout(() => {
      pulseEl.classList.add('hit');
      setTimeout(() => pulseEl.classList.remove('hit'), 100);
    }, Math.max(0, delay));

    beat++;
    syncTimer = setTimeout(scheduleBeat, interval * 1000);
  }
  scheduleBeat();

  window.addEventListener('keydown', syncTapHandler);
  document.getElementById('sync-pulse').addEventListener('pointerdown', syncTapHandler);
}

function syncTapHandler(e) {
  if (e.type === 'keydown' && e.code !== 'Space') return;
  if (!syncCtx) return;
  syncTaps.push(syncCtx.currentTime);
}

function stopSync() {
  clearTimeout(syncTimer);
  syncTimer = null;
  window.removeEventListener('keydown', syncTapHandler);
  document.getElementById('sync-pulse').removeEventListener('pointerdown', syncTapHandler);
  document.getElementById('sync-start-btn').textContent = 'Start Calibration';

  if (syncTaps.length && syncBeatTimes.length) {
    const diffs = [];
    for (const tap of syncTaps) {
      let nearest = syncBeatTimes[0], best = Infinity;
      for (const b of syncBeatTimes) {
        const d = Math.abs(tap - b);
        if (d < best) { best = d; nearest = b; }
      }
      if (best < 0.3) diffs.push((tap - nearest) * 1000);
    }
    if (diffs.length) {
      const avg = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
      const s = Account.getSettings();
      s.audioOffsetMs = avg;
      Account.saveSettings(s);
      document.getElementById('sync-offset-display').textContent = avg + ' ms';
    }
  }
  if (syncCtx) { syncCtx.close(); syncCtx = null; }
}

// ---------------- manage / add song generator ----------------

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'song';
}
const DIFF_CODE = { Standard: 'ST', Gold: 'GOLD', Diamond: 'DIAMOND' };

function updateGenFolder() {
  const title = document.getElementById('gen-title').value.trim() || 'song';
  const diff = document.getElementById('gen-diff').value;
  document.getElementById('gen-folder').value = `${slugify(title)}_${DIFF_CODE[diff]}`;
}
['gen-title', 'gen-diff'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateGenFolder);
  document.getElementById(id).addEventListener('change', updateGenFolder);
});

document.getElementById('gen-build-btn').addEventListener('click', () => {
  updateGenFolder();
  const info = {
    title: document.getElementById('gen-title').value.trim() || 'Untitled',
    artist: document.getElementById('gen-artist').value.trim() || 'Unknown Artist',
    difficulty: document.getElementById('gen-diff').value,
    bpm: parseInt(document.getElementById('gen-bpm').value, 10) || 120,
    audio: 'audio.mp3',
    artwork: 'artwork.jpg',
    chart: 'chart.chart'
  };
  const folder = document.getElementById('gen-folder').value;
  document.getElementById('gen-output').value = JSON.stringify(info, null, 2);
  document.getElementById('gen-folder-echo').textContent = `"${folder}"`;
  document.getElementById('gen-output-wrap').style.display = 'block';
});

document.getElementById('gen-copy-btn').addEventListener('click', () => {
  const ta = document.getElementById('gen-output');
  ta.select();
  document.execCommand('copy');
});

// ---------------- profile ----------------

function renderAvatarGrid(selected) {
  const grid = document.getElementById('avatar-grid');
  grid.innerHTML = '';
  Account.AVATARS.forEach(a => {
    const btn = document.createElement('div');
    btn.className = 'avatar-opt' + (a === selected ? ' selected' : '');
    btn.textContent = a;
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.avatar-opt').forEach(x => x.classList.remove('selected'));
      btn.classList.add('selected');
    });
    grid.appendChild(btn);
  });
}

function renderProfileScreen() {
  const profile = Account.getProfile();
  document.getElementById('profile-name').value = profile.name;
  renderAvatarGrid(profile.avatar);
  document.getElementById('profile-avatar').textContent = profile.avatar;

  const scores = Account.getAllScores();
  const listEl = document.getElementById('highscore-list');
  listEl.innerHTML = '';
  const keys = Object.keys(scores);
  if (!keys.length) {
    listEl.innerHTML = '<p class="muted small">No scores yet — go play something!</p>';
    return;
  }
  keys.forEach(k => {
    const s = scores[k];
    const row = document.createElement('div');
    row.className = 'highscore-row';
    row.innerHTML = `<span>${escapeHtml(k)}</span><span>${s.grade} · ${s.score}</span>`;
    listEl.appendChild(row);
  });
}

document.getElementById('profile-save-btn').addEventListener('click', () => {
  const name = document.getElementById('profile-name').value.trim() || 'Player';
  const selected = document.querySelector('.avatar-opt.selected');
  const avatar = selected ? selected.textContent : '🎧';
  Account.saveProfile({ name, avatar });
  document.getElementById('profile-avatar').textContent = avatar;
});

// ---------------- boot ----------------

initSettingsScreen();
loadLibrary();
const initialProfile = Account.getProfile();
document.getElementById('profile-avatar').textContent = initialProfile.avatar;
