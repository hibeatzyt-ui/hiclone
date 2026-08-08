// game.js — Hi Clone gameplay engine
//
// CHART FORMAT (chart.chart — plain JSON saved with a .chart extension),
// lanes are numbered 1-4 in the file:
//   { "bpm": 120, "offset": 0, "notes": [
//       { "t": 1.50, "lane": 2, "type": "tap" },
//       { "t": 2.25, "lane": 1, "type": "l2" },      // swipe LEFT across 2 lanes, starts at lane 1
//       { "t": 3.00, "lane": 4, "type": "r1" },      // swipe RIGHT across 1 lane, starts at lane 4
//       { "t": 3.50, "lane": 4, "type": "l4" },      // swipe LEFT across all 4 lanes
//       { "t": 4.00, "lane": 1, "type": "r4" },      // swipe RIGHT across all 4 lanes
//       { "t": 4.00, "type": "h2>3", "dur": 0.6 }    // noodle hold: lane 2 dragging to lane 3
//   ]}
//
// Keys: D F J K = lanes 1-4. Left/Right arrow = swipe direction (keyboard players).
// Touch: swipe across a lane strip to satisfy swipe notes; press+hold for noodle notes.

const JUDGE = {
  PERFECT: { label: 'PERFECT+', window: 0.045, score: 1000, color: '#4dff88' },
  GREAT:   { label: 'GREAT',    window: 0.090, score: 700,  color: '#9b5de5' },
  GOOD:    { label: 'GOOD',     window: 0.140, score: 300,  color: '#ffc145' },
  MISS:    { label: 'MISS',     window: Infinity, score: 0, color: '#ff4d5e' }
};

function parseChart(chartData) {
  const bpm = chartData.bpm || 120;
  const offset = chartData.offset || 0;
  const notes = (chartData.notes || []).map((raw, i) => {
    const base = { id: i, t: raw.t, judged: false, judgment: null };
    const type = raw.type || 'tap';

    const holdMatch = /^h(\d)>(\d)$/.exec(type);
    if (holdMatch) {
      return Object.assign(base, {
        kind: 'hold',
        startLane: parseInt(holdMatch[1], 10) - 1,
        endLane: parseInt(holdMatch[2], 10) - 1,
        dur: raw.dur || 0.5,
        holdState: 'pending',
        heldMs: 0
      });
    }

    const swipeMatch = /^([lr])([1-4])$/.exec(type);
    if (swipeMatch) {
      return Object.assign(base, {
        kind: 'swipe',
        lane: (raw.lane || 1) - 1,
        dir: swipeMatch[1],
        mag: parseInt(swipeMatch[2], 10)
      });
    }

    return Object.assign(base, { kind: 'tap', lane: (raw.lane || 1) - 1 });
  });

  notes.sort((a, b) => a.t - b.t);
  return { bpm, offset, notes };
}

class HiCloneGame {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.laneCount = 4;
    this.laneColors = ['#ff3e9a', '#35e8e0', '#ffc145', '#9b5de5'];
    this.scrollBase = 460; // px/sec at speed 1.0
    this.hitLineFrac = 0.82;

    this.speedMultiplier = opts.speed || 1.0;
    this.audioOffsetSec = (opts.audioOffsetMs || 0) / 1000;

    this.audio = opts.audio; // HTMLAudioElement
    this.chart = null;
    this.notes = [];

    this.running = false;
    this.finished = false;
    this.rafId = null;

    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
    this.judged = 0;
    this.judgeable = 0;

    this.pressed = new Set();       // currently-held lane indices (keyboard/touch)
    this.lastArrow = null;          // {dir:'l'|'r', time}
    this.activeHolds = new Map();   // note.id -> {pressStart}
    this.particles = [];
    this.laneFlash = [0, 0, 0, 0];  // per-lane glow decay for hit feedback

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.laneW = this.w / this.laneCount; // fallback flat width, unused by perspective draw
    this.hitY = this.h * 0.80;
    this.trackTopY = this.h * 0.02;
    this.topWidthFrac = 0.20;
    this.bottomWidthFrac = 1.0;
  }

  load(chartData) {
    this.chart = parseChart(chartData);
    this.notes = this.chart.notes;
    this.judgeable = this.notes.length;
  }

  songTime() {
    if (!this.audio) return 0;
    return this.audio.currentTime - (this.chart ? this.chart.offset : 0) - this.audioOffsetSec;
  }

  start() {
    this.running = true;
    this.finished = false;
    this.audio.currentTime = 0;
    const playPromise = this.audio.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
    this._loop();
  }

  pause() {
    this.running = false;
    this.audio.pause();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  resume() {
    if (this.finished) return;
    this.running = true;
    const p = this.audio.play();
    if (p && p.catch) p.catch(() => {});
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    try { this.audio.pause(); } catch (e) {}
  }

  setSpeed(mult) { this.speedMultiplier = mult; }

  // ---------------- input ----------------

  handleLaneDown(lane) {
    if (!this.running) return;
    this.pressed.add(lane);
    const t = this.songTime();
    this._tryJudgeLane(lane, t);
  }

  handleLaneUp(lane) {
    this.pressed.delete(lane);
    // resolve any active hold that used this lane as its startLane
    for (const [id, h] of this.activeHolds.entries()) {
      const note = this.notes.find(n => n.id === id);
      if (note && note.startLane === lane && note.holdState === 'active') {
        this._resolveHold(note, this.songTime());
      }
    }
  }

  handleArrow(dir) {
    this.lastArrow = { dir, time: this.songTime() };
  }

  _tryJudgeLane(lane, t) {
    // find closest un-judged tap/swipe note in this lane, or a hold about to start
    let best = null, bestDt = Infinity;
    for (const n of this.notes) {
      if (n.judged) continue;
      if (n.kind === 'hold') {
        if (n.startLane === lane && n.holdState === 'pending') {
          const dt = Math.abs(n.t - t);
          if (dt < JUDGE.GOOD.window && dt < bestDt) { best = n; bestDt = dt; }
        }
        continue;
      }
      if (n.lane !== lane) continue;
      const dt = Math.abs(n.t - t);
      if (dt < JUDGE.GOOD.window * 1.6 && dt < bestDt) { best = n; bestDt = dt; }
    }
    if (!best) return;

    if (best.kind === 'hold') {
      best.holdState = 'active';
      this.activeHolds.set(best.id, { pressStart: t });
      return;
    }

    let tier = this._tierFor(bestDt);
    if (best.kind === 'swipe') {
      const needDir = best.dir;
      const arrowOk = this.lastArrow && this.lastArrow.dir === needDir &&
        Math.abs(this.lastArrow.time - t) < 0.15;
      if (!arrowOk && tier === 'PERFECT') tier = 'GREAT';
      if (!arrowOk && tier === 'GREAT') tier = 'GOOD';
    }
    this._commitJudgment(best, tier);
  }

  _tierFor(dt) {
    if (dt <= JUDGE.PERFECT.window) return 'PERFECT';
    if (dt <= JUDGE.GREAT.window) return 'GREAT';
    if (dt <= JUDGE.GOOD.window) return 'GOOD';
    return 'MISS';
  }

  _resolveHold(note, t) {
    const info = this.activeHolds.get(note.id);
    this.activeHolds.delete(note.id);
    if (!info) return;
    const held = t - info.pressStart;
    const ratio = note.dur > 0 ? held / note.dur : 1;
    let tier;
    if (ratio >= 0.92) tier = 'PERFECT';
    else if (ratio >= 0.7) tier = 'GREAT';
    else if (ratio >= 0.4) tier = 'GOOD';
    else tier = 'MISS';
    note.holdState = 'done';
    this._commitJudgment(note, tier, note.startLane);
  }

  _commitJudgment(note, tier, laneForFx) {
    note.judged = true;
    note.judgment = tier;
    this.judged++;
    this.counts[tier]++;
    const lane = laneForFx !== undefined ? laneForFx : note.lane;
    if (tier === 'MISS') {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      const comboBonus = Math.min(this.combo, 100) * 2;
      this.score += JUDGE[tier].score + comboBonus;
      if (typeof lane === 'number') {
        this.laneFlash[lane] = 1;
        this._spawnSparkles(lane, JUDGE[tier].color);
      }
    }
    if (this.opts.onJudgment) this.opts.onJudgment(tier, note);
    if (this.opts.onScoreUpdate) this.opts.onScoreUpdate(this.score, this.combo);
  }

  _spawnSparkles(lane, color) {
    const x = this._laneXAt(lane, 1);
    const y = this.hitY;
    for (let i = 0; i < 7; i++) {
      const ang = (Math.PI * 2 * i) / 7 + Math.random() * 0.5;
      const speed = 60 + Math.random() * 90;
      this.particles.push({
        x, y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - 40,
        life: 1,
        color,
        rot: Math.random() * Math.PI
      });
    }
  }

  // ---------------- loop ----------------

  _loop() {
    if (!this.running) return;
    const t = this.songTime();

    // auto-miss notes that scrolled past the judge window
    for (const n of this.notes) {
      if (n.judged) continue;
      if (n.kind === 'hold') {
        if (n.holdState === 'pending' && t - n.t > JUDGE.GOOD.window) {
          n.judged = true; n.holdState = 'missed'; n.judgment = 'MISS';
          this.judged++; this.counts.MISS++; this.combo = 0;
          if (this.opts.onJudgment) this.opts.onJudgment('MISS', n);
        } else if (n.holdState === 'active' && t - n.t > n.dur + JUDGE.GOOD.window) {
          this._resolveHold(n, t);
        }
        continue;
      }
      if (t - n.t > JUDGE.GOOD.window) {
        n.judged = true; n.judgment = 'MISS';
        this.judged++; this.counts.MISS++; this.combo = 0;
        if (this.opts.onJudgment) this.opts.onJudgment('MISS', n);
      }
    }

    this._draw(t);

    const songDone = this.audio.ended || (this.audio.duration && this.audio.currentTime >= this.audio.duration - 0.05);
    if (songDone && this.judged >= this.judgeable) {
      this.finished = true;
      this.running = false;
      if (this.opts.onFinish) this.opts.onFinish(this.getResults());
      return;
    }

    this.rafId = requestAnimationFrame(() => this._loop());
  }

  getResults() {
    const total = this.judgeable || 1;
    const acc = ((this.counts.PERFECT * 1 + this.counts.GREAT * 0.7 + this.counts.GOOD * 0.4) / total) * 100;
    let grade = 'D';
    if (acc >= 97) grade = 'SS';
    else if (acc >= 93) grade = 'S';
    else if (acc >= 85) grade = 'A';
    else if (acc >= 75) grade = 'B';
    else if (acc >= 60) grade = 'C';
    return {
      score: this.score,
      accuracy: Math.round(acc * 10) / 10,
      grade,
      maxCombo: this.maxCombo,
      counts: Object.assign({}, this.counts)
    };
  }

  // ---------------- render ----------------

  // Perspective track: lanes converge toward the top (near the disc header)
  // and spread to full width at the hit line, like the reference screenshot.

  _trackFrac(y) {
    const span = this.hitY - this.trackTopY;
    if (span <= 0) return 1;
    let f = (y - this.trackTopY) / span;
    if (f < 0) f = 0;
    if (f > 1.3) f = 1.3;
    return f;
  }

  _trackWidthAt(tf) {
    const wf = this.topWidthFrac + (this.bottomWidthFrac - this.topWidthFrac) * tf;
    return this.w * wf;
  }

  _laneXAt(lane, tf) {
    const totalWidth = this._trackWidthAt(tf);
    const x0 = this.w / 2 - totalWidth / 2;
    const laneW = totalWidth / this.laneCount;
    return x0 + laneW * (lane + 0.5);
  }

  _laneBoundsAt(tf) {
    const totalWidth = this._trackWidthAt(tf);
    const x0 = this.w / 2 - totalWidth / 2;
    const laneW = totalWidth / this.laneCount;
    return { x0, laneW, x1: x0 + totalWidth };
  }

  _draw(t) {
    const ctx = this.ctx, w = this.w, h = this.h;
    ctx.clearRect(0, 0, w, h);

    this._drawTrack();

    // per-lane press glow (perspective trapezoid, not a flat rect)
    for (let lane = 0; lane < this.laneCount; lane++) {
      if (this.pressed.has(lane) || this.laneFlash[lane] > 0.02) {
        const glowAlpha = this.pressed.has(lane) ? 0.16 : this.laneFlash[lane] * 0.22;
        const top = this._laneBoundsAt(0);
        const bot = this._laneBoundsAt(1);
        ctx.beginPath();
        ctx.moveTo(top.x0 + top.laneW * lane, this.trackTopY);
        ctx.lineTo(top.x0 + top.laneW * (lane + 1), this.trackTopY);
        ctx.lineTo(bot.x0 + bot.laneW * (lane + 1), this.hitY);
        ctx.lineTo(bot.x0 + bot.laneW * lane, this.hitY);
        ctx.closePath();
        ctx.fillStyle = this._hexA(this.laneColors[lane], glowAlpha);
        ctx.fill();
      }
      this.laneFlash[lane] *= 0.9;
    }

    const pxPerSec = this.scrollBase * this.speedMultiplier;

    for (const n of this.notes) {
      if (n.judged && n.kind !== 'hold') continue;
      if (n.kind === 'hold' && (n.holdState === 'done' || n.holdState === 'missed')) continue;

      if (n.kind === 'hold') {
        this._drawHold(n, t, pxPerSec);
        continue;
      }

      const y = this.hitY - (n.t - t) * pxPerSec;
      if (y < this.trackTopY - 30 || y > h + 40) continue;
      const tf = this._trackFrac(y);
      const x = this._laneXAt(n.lane, tf);
      const scale = 0.42 + 0.58 * tf;
      const color = this.laneColors[n.lane];

      if (n.kind === 'tap') {
        this._drawTap(x, y, color, scale);
      } else {
        this._drawSwipe(x, y, color, n.dir, n.mag, scale);
      }
    }

    this._updateParticles();
  }

  _drawTrack() {
    const ctx = this.ctx;
    const top = this._laneBoundsAt(0);
    const bot = this._laneBoundsAt(1);

    // glowing fill
    const grad = ctx.createLinearGradient(0, this.trackTopY, 0, this.hitY);
    grad.addColorStop(0, 'rgba(20,80,60,0.10)');
    grad.addColorStop(1, 'rgba(40,200,120,0.28)');
    ctx.beginPath();
    ctx.moveTo(top.x0, this.trackTopY);
    ctx.lineTo(top.x1, this.trackTopY);
    ctx.lineTo(bot.x1, this.hitY);
    ctx.lineTo(bot.x0, this.hitY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // inner converging dividers (3 lines between 4 lanes)
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(160,255,210,0.22)';
    for (let i = 1; i < this.laneCount; i++) {
      ctx.beginPath();
      ctx.moveTo(top.x0 + top.laneW * i, this.trackTopY);
      ctx.lineTo(bot.x0 + bot.laneW * i, this.hitY);
      ctx.stroke();
    }

    // bright glowing outer edges
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(120,255,190,0.9)';
    ctx.shadowColor = '#5dffb0';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(top.x0, this.trackTopY);
    ctx.lineTo(bot.x0, this.hitY);
    ctx.moveTo(top.x1, this.trackTopY);
    ctx.lineTo(bot.x1, this.hitY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // hit line
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bot.x0, this.hitY);
    ctx.lineTo(bot.x1, this.hitY);
    ctx.stroke();
  }

  _hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }

  _drawTap(x, y, color, scale) {
    const ctx = this.ctx;
    const rw = 62 * scale, rh = 24 * scale;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 * scale;
    this._roundRect(x - rw / 2, y - rh / 2, rw, rh, 8 * scale);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  _drawSwipe(x, y, color, dir, mag, scale) {
    const ctx = this.ctx;
    const rw = 62 * scale, rh = 24 * scale;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12 * scale;
    this._roundRect(x - rw / 2, y - rh / 2, rw, rh, 8 * scale);
    ctx.fill();
    ctx.shadowBlur = 0;
    // arrow
    ctx.fillStyle = '#0a0a13';
    ctx.beginPath();
    const ax = dir === 'r' ? x - 5 * scale : x + 5 * scale;
    const flip = dir === 'r' ? 1 : -1;
    ctx.moveTo(ax + 7 * scale * flip, y);
    ctx.lineTo(ax - 4 * scale * flip, y - 6 * scale);
    ctx.lineTo(ax - 4 * scale * flip, y + 6 * scale);
    ctx.closePath();
    ctx.fill();
    // magnitude ticks
    ctx.fillStyle = 'rgba(10,10,19,0.7)';
    for (let i = 0; i < mag; i++) {
      ctx.fillRect(x + (dir === 'r' ? (14 + i * 6) * scale : (-18 - i * 6) * scale), y - 2 * scale, 3 * scale, 4 * scale);
    }
  }

  _drawHold(n, t, pxPerSec) {
    const ctx = this.ctx;

    if (n.holdState === 'pending') {
      const y = this.hitY - (n.t - t) * pxPerSec;
      if (y < this.trackTopY - 30 || y > this.h + 40) return;
      const tf = this._trackFrac(y);
      const scale = 0.42 + 0.58 * tf;
      const xa = this._laneXAt(n.startLane, tf), xb = this._laneXAt(n.endLane, tf);
      const color = this.laneColors[n.startLane];

      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12 * scale;
      ctx.beginPath();
      ctx.arc(xa, y, 13 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // little "noodle" tail hinting the drag target
      ctx.strokeStyle = color + '99';
      ctx.lineWidth = 4 * scale;
      ctx.beginPath();
      ctx.moveTo(xa, y);
      ctx.lineTo(xb, y - 26 * scale);
      ctx.stroke();
    } else if (n.holdState === 'active') {
      const info = this.activeHolds.get(n.id);
      const ratio = info ? Math.min(1, (t - info.pressStart) / n.dur) : 0;
      const xa = this._laneXAt(n.startLane, 1), xb = this._laneXAt(n.endLane, 1);
      const color = this.laneColors[n.startLane];
      const cx = xa + (xb - xa) * ratio;
      ctx.strokeStyle = color;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.moveTo(xa, this.hitY);
      ctx.lineTo(cx, this.hitY);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx, this.hitY, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _updateParticles() {
    const ctx = this.ctx;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * (1 / 60);
      p.y += p.vy * (1 / 60);
      p.vy += 220 * (1 / 60);
      p.life -= 1 / 34;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.fillRect(-3, -3, 6, 6);
      ctx.restore();
    }
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
