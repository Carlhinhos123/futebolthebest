import {
  BALL_R, CHARGE_MAX, FIELD, FIELD_H, FIELD_W, PLAYER_R, TEAM_PRESETS, kitFor,
  WORLD_H, WORLD_W,
} from '../constants.js';
import { clamp, dist2, norm } from '../util.js';
import { buildPitch } from './pitch.js';
import { STRIDE, facing, kitSprites } from './sprites.js';
import { getNextSwitchCandidate } from '../game/sim.js';

function safeRoundRect(ctx, x, y, w, h, r = 0) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function makeGradient(ctx, x1, y1, x2, y2, stops, fallbackColor) {
  try {
    if (typeof ctx.createLinearGradient === 'function') {
      const g = ctx.createLinearGradient(x1, y1, x2, y2);
      if (g && typeof g.addColorStop === 'function') {
        for (const [pos, color] of stops) g.addColorStop(pos, color);
        return g;
      }
    }
  } catch {
    /* fallback */
  }
  return fallbackColor;
}

const ZOOM = 1.35;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pitch = buildPitch();
    this.cam = { x: FIELD.cx, y: FIELD.cy };
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.strides = new Map();
    this.ballHistory = [];
    this.particles = [];
    this.goalBannerAnim = 0;
    this.stats = {
      possessionTicks: [1, 1],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      tackles: [0, 0],
      corners: [0, 0],
      goals: [],
    };
    this._lastScoredTick = -999;
  }

  resetStats() {
    this.stats = {
      possessionTicks: [1, 1],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      tackles: [0, 0],
      corners: [0, 0],
      goals: [],
    };
    this.particles = [];
    this.ballHistory = [];
    this.goalBannerAnim = 0;
  }

  rebuildPitch() {
    this.pitch = buildPitch();
  }

  updateCamera(state, instant = false) {
    const b = state.ball;
    const targetX = clamp(b.x + b.vx * 0.16, 0, WORLD_W);
    const targetY = clamp(b.y + b.vy * 0.16, 0, WORLD_H);
    const k = instant ? 1 : 0.12;
    this.cam.x += (targetX - this.cam.x) * k;
    this.cam.y += (targetY - this.cam.y) * k;

    const halfW = this.canvas.width / (2 * ZOOM);
    const halfH = this.canvas.height / (2 * ZOOM);
    this.cam.x = WORLD_W <= halfW * 2 ? WORLD_W / 2 : clamp(this.cam.x, halfW, WORLD_W - halfW);
    this.cam.y = WORLD_H <= halfH * 2 ? WORLD_H / 2 : clamp(this.cam.y, halfH, WORLD_H - halfH);
  }

  updateStatsAndParticles(state) {
    const b = state.ball;

    // Track possession ticks
    if (state.phase === 'play') {
      if (b.owner) {
        this.stats.possessionTicks[b.owner.team]++;
      } else if (b.lastTouch) {
        this.stats.possessionTicks[b.lastTouch.team]++;
      }
    }

    // Process events for stats & celebratory particles
    if (state.events && state.events.length) {
      for (const e of state.events) {
        if (e.type === 'goal') {
          this.stats.shots[e.team]++;
          this.stats.shotsOnTarget[e.team]++;
          const scorerIdx = b.lastTouch ? b.lastTouch.idx : 9;
          const teamObj = state.teams[e.team];
          const scorerName = (teamObj.squad && teamObj.squad[scorerIdx]) || `${teamObj.name} #${scorerIdx + 1}`;
          const min = matchMinute(state);
          this.stats.goals.push({ team: e.team, scorer: scorerName, minute: min });
          this.goalBannerAnim = 1.0;
          this.spawnConfetti();
        } else if (e.type === 'save') {
          const shooterTeam = 1 - e.team;
          this.stats.shots[shooterTeam]++;
          this.stats.shotsOnTarget[shooterTeam]++;
        } else if (e.type === 'slide') {
          // Slide tackle attempt
          const t = b.owner ? 1 - b.owner.team : (b.lastTouch ? 1 - b.lastTouch.team : 0);
          this.stats.tackles[t]++;
        } else if (e.type === 'restart' && e.kind === 'CORNER') {
          this.stats.corners[e.team]++;
        }
      }
    }

    // Ball motion history for rocket shots trail
    const bSpeed = Math.hypot(b.vx, b.vy);
    if (bSpeed > 320) {
      this.ballHistory.push({ x: b.x, y: b.y, z: b.z, life: 1.0 });
      if (this.ballHistory.length > 8) this.ballHistory.shift();
    } else if (this.ballHistory.length) {
      this.ballHistory.shift();
    }
    for (const bh of this.ballHistory) {
      bh.life -= 0.12;
    }
    this.ballHistory = this.ballHistory.filter((bh) => bh.life > 0);

    // Update active particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  spawnConfetti() {
    const colors = ['#00f0ff', '#ffd700', '#ff3366', '#00ff88', '#ffffff', '#ff8800'];
    for (let i = 0; i < 65; i++) {
      this.particles.push({
        x: this.canvas.width / 2 + (Math.random() - 0.5) * 360,
        y: Math.random() * 80,
        vx: (Math.random() - 0.5) * 4,
        vy: 2 + Math.random() * 4,
        size: 4 + Math.random() * 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1.0,
        decay: 0.007 + Math.random() * 0.008,
      });
    }
  }

  spawnTurfSpray(x, y, dx, dy) {
    for (let i = 0; i < 4; i++) {
      this.particles.push({
        world: true,
        x,
        y,
        vx: -dx * (1.5 + Math.random() * 2) + (Math.random() - 0.5) * 2,
        vy: -dy * (1.5 + Math.random() * 2) + (Math.random() - 0.5) * 2,
        size: 2 + Math.random() * 1.5,
        color: Math.random() < 0.6 ? '#227835' : '#1b5f27',
        life: 0.8,
        decay: 0.05,
      });
    }
  }

  draw(state, net = null) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    this.updateStatsAndParticles(state);
    this.updateCamera(state);

    if (state.phase === 'goal' && state.phaseTimer > 130) this.shake = 8;
    this.shake *= 0.88;
    const sx = this.shake > 0.2 ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake > 0.2 ? (Math.random() - 0.5) * this.shake : 0;
    this.shakeX = sx;
    this.shakeY = sy;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a1a0f';
    ctx.fillRect(0, 0, W, H);

    ctx.setTransform(ZOOM, 0, 0, ZOOM, -this.cam.x * ZOOM + W / 2 + sx, -this.cam.y * ZOOM + H / 2 + sy);
    ctx.drawImage(this.pitch, 0, 0);

    // Directional 4-point floodlight stadium shadows
    this.drawShadows(ctx, state);

    // World particles (e.g. grass spray)
    for (const p of this.particles) {
      if (p.world) {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
    }

    // Players sorted top to bottom
    const all = [];
    for (let t = 0; t < 2; t++) {
      state.teams[t].players.forEach((p, i) => all.push({ p, t, i }));
    }
    all.sort((a, b) => a.p.y - b.p.y);
    for (const e of all) this.drawPlayer(ctx, state, e.t, e.i, e.p);

    // Ball & rocket speed trail
    this.drawBallTrail(ctx);
    this.drawBall(ctx, state);

    // Screen-space HUD & Broadcast presentation
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Screen confetti
    for (const p of this.particles) {
      if (!p.world) {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
    }

    this.drawHud(ctx, state, net);
    this.drawPlayerCard(ctx, state);
    this.drawRadar(ctx, state);
    this.drawMessage(ctx, state, net);
    if (net) this.drawNetStatus(ctx, net);

    // Half-time & Full-time Match Summary Overlay
    if ((state.phase === 'halftime' || state.phase === 'fulltime') && !net) {
      this.drawMatchSummary(ctx, state);
    }
  }

  /** 4-point floodlight shadows give that authentic night console stadium look */
  drawShadows(ctx, state) {
    const shadowOffsets = [
      { dx: -2.2, dy: -2.6, a: 0.11 },
      { dx: 2.2, dy: -2.6, a: 0.11 },
      { dx: -2.2, dy: 3.8, a: 0.15 },
      { dx: 2.2, dy: 3.8, a: 0.15 },
    ];

    for (const team of state.teams) {
      for (const p of team.players) {
        for (const off of shadowOffsets) {
          ctx.fillStyle = `rgba(0,0,0,${off.a})`;
          ctx.beginPath();
          ctx.ellipse(p.x + off.dx, p.y + off.dy, PLAYER_R * 0.85, PLAYER_R * 0.48, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const b = state.ball;
    const s = clamp(1 - b.z / 260, 0.35, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.36)';
    ctx.beginPath();
    ctx.ellipse(b.x + 2, b.y + 3, BALL_R * s, BALL_R * 0.75 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  toScreen(x, y) {
    return {
      x: Math.round((x - this.cam.x) * ZOOM + this.canvas.width / 2 + this.shakeX),
      y: Math.round((y - this.cam.y) * ZOOM + this.canvas.height / 2 + this.shakeY),
    };
  }

  drawPlayer(ctx, state, t, i, p) {
    const team = state.teams[t];
    const kit = kitFor(t, i);
    const isControlled = team.human && team.controlled === i;
    const sprites = kitSprites(kit, ZOOM, kit.id);

    let view = facing(p.dirX, p.dirY);
    if (p.slide > 0 || p.down > 0) {
      view = `slide${view[0].toUpperCase()}${view.slice(1)}`;
      if (p.slide > 0 && Math.random() < 0.3) {
        this.spawnTurfSpray(p.x, p.y, p.dirX, p.dirY);
      }
    } else {
      const key = t * 100 + i;
      const run = (this.strides.get(key) || 0) + Math.hypot(p.vx, p.vy) / 60;
      this.strides.set(key, run);
      view += Math.floor(run / STRIDE) % 2;
    }
    const sprite = sprites[view] || sprites.down0;

    // Grass slide marks
    if (p.slide > 0) {
      const fade = Math.min(1, p.slide / 14);
      ctx.strokeStyle = `rgba(220, 240, 220, ${0.35 * fade})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x - p.dirX * 4, p.y - p.dirY * 4 + 3);
      ctx.lineTo(p.x - p.dirX * 22, p.y - p.dirY * 22 + 3);
      ctx.stroke();
    }

    // Active player turf glow ring
    if (isControlled) {
      const ringColor = t === 0 ? 'rgba(0, 240, 255, 0.45)' : 'rgba(255, 51, 102, 0.45)';
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 2, PLAYER_R + 3, PLAYER_R * 0.55 + 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Next-player switch candidate indicator (TROCAR)
    const isNextCandidate = team.human && !isControlled && this.isNextSwitchCandidate(state, t, i);
    if (isNextCandidate) {
      const bob = Math.sin(Date.now() / 150) * 2;
      const arrowY = p.y - PLAYER_R - 8 + bob;

      // Subtle shadow/border
      ctx.fillStyle = '#0a1a0f';
      ctx.beginPath();
      ctx.moveTo(p.x, arrowY + 2);
      ctx.lineTo(p.x - 5, arrowY - 6);
      ctx.lineTo(p.x + 5, arrowY - 6);
      ctx.closePath();
      ctx.fill();

      // Glowing amber / gold chevron
      ctx.fillStyle = '#ffaa00';
      ctx.beginPath();
      ctx.moveTo(p.x, arrowY);
      ctx.lineTo(p.x - 4, arrowY - 5);
      ctx.lineTo(p.x + 4, arrowY - 5);
      ctx.closePath();
      ctx.fill();

      // Target selection ring
      ctx.strokeStyle = 'rgba(255, 170, 0, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 2, PLAYER_R + 4, PLAYER_R * 0.55 + 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Dynamic sprint burst effect lines
    if (p.burst > 0) {
      const angle = Math.atan2(p.vy || team.attackDir, p.vx || 0);
      const bColor = t === 0 ? 'rgba(0, 240, 255, 0.65)' : 'rgba(255, 170, 0, 0.65)';
      ctx.strokeStyle = bColor;
      ctx.lineWidth = 2;
      for (let s = -1; s <= 1; s += 2) {
        const offX = -Math.cos(angle) * 7 + Math.sin(angle) * (s * 5);
        const offY = -Math.sin(angle) * 7 - Math.cos(angle) * (s * 5);
        ctx.beginPath();
        ctx.moveTo(p.x + offX, p.y + offY);
        ctx.lineTo(p.x + offX * 1.7, p.y + offY * 1.7);
        ctx.stroke();
      }
    }

    // Draw sprite in whole screen pixels
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const at = this.toScreen(p.x, p.y);
    ctx.drawImage(
      sprite,
      at.x - Math.round(sprite.width / 2),
      at.y - Math.round(sprite.height * 0.60),
    );
    ctx.imageSmoothingEnabled = true;
    ctx.restore();

    // 3D Animated Floating Console Chevron above controlled player
    if (isControlled) {
      const bob = Math.sin(Date.now() / 140) * 2;
      const arrowY = p.y - PLAYER_R - 7 + bob;
      const mainColor = t === 0 ? '#00f0ff' : '#ff3366';

      // Chevron border / shadow
      ctx.fillStyle = '#0a1a0f';
      ctx.beginPath();
      ctx.moveTo(p.x, arrowY + 2);
      ctx.lineTo(p.x - 5.5, arrowY - 6.5);
      ctx.lineTo(p.x + 5.5, arrowY - 6.5);
      ctx.closePath();
      ctx.fill();

      // Neon chevron
      ctx.fillStyle = mainColor;
      ctx.beginPath();
      ctx.moveTo(p.x, arrowY);
      ctx.lineTo(p.x - 4, arrowY - 5);
      ctx.lineTo(p.x + 4, arrowY - 5);
      ctx.closePath();
      ctx.fill();

      // In-world charging meter
      if (p.charging && p.charge > 0) {
        const w = 26;
        const f = clamp(p.charge / CHARGE_MAX, 0, 1);
        ctx.fillStyle = 'rgba(10, 20, 15, 0.85)';
        ctx.fillRect(p.x - w / 2 - 1, p.y + PLAYER_R + 3, w + 2, 5);

        const meterColor = f > 0.85 ? '#ff3344' : f > 0.45 ? '#ffd700' : '#00e5ff';
        ctx.fillStyle = meterColor;
        ctx.fillRect(p.x - w / 2, p.y + PLAYER_R + 4, w * f, 3);

        if (f > 0.85) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.strokeRect(p.x - w / 2 - 1, p.y + PLAYER_R + 3, w + 2, 5);
        }
      }
    }
  }

  isNextSwitchCandidate(state, t, i) {
    return getNextSwitchCandidate(state, t) === i;
  }

  drawBallTrail(ctx) {
    for (let i = 0; i < this.ballHistory.length; i++) {
      const bh = this.ballHistory[i];
      const alpha = bh.life * 0.35;
      const y = bh.y - bh.z * 0.6;
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(bh.x, y, BALL_R * 0.8 * bh.life, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawBall(ctx, state) {
    const b = state.ball;
    const y = b.y - b.z * 0.6;
    const r = BALL_R + clamp(b.z / 120, 0, 1.6);

    ctx.beginPath();
    ctx.arc(b.x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();

    // 3D ball highlight
    ctx.beginPath();
    ctx.arc(b.x - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
  }

  /** Console Television Broadcast Scoreboard (Top HUD) */
  drawHud(ctx, state, net) {
    const W = this.canvas.width;
    const team0 = state.teams[0];
    const team1 = state.teams[1];

    const short0 = team0.short || (team0.name ? team0.name.slice(0, 3).toUpperCase() : 'TM1');
    const short1 = team1.short || (team1.name ? team1.name.slice(0, 3).toUpperCase() : 'TM2');

    const boardW = 340;
    const boardH = 34;
    const bx = W / 2 - boardW / 2;
    const by = 12;

    // Outer broadcast container with glassmorphism gradient
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;

    const grad = makeGradient(ctx, bx, by, bx, by + boardH, [[0, '#101a24'], [1, '#080d14']], '#101a24');
    ctx.fillStyle = grad;
    ctx.beginPath();
    safeRoundRect(ctx, bx, by, boardW, boardH, 6);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // Team 0 badge & text
    ctx.fillStyle = TEAM_PRESETS[0]?.shirt || '#f5f5f5';
    ctx.beginPath();
    safeRoundRect(ctx, bx + 10, by + 9, 16, 16, 3);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 14px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(short0, bx + 32, by + boardH / 2);

    // Score
    ctx.font = 'bold 18px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(state.score[0]), bx + 106, by + boardH / 2);

    // Center divider & match clock
    const min = matchMinute(state);
    const halfLabel = state.half === 1 ? '1T' : '2T';
    const clockText = `${min}'`;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(bx + 124, by + 6, 92, boardH - 12);

    ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#00f0ff';
    ctx.fillText(halfLabel, bx + 144, by + boardH / 2);

    ctx.font = 'bold 14px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(clockText, bx + 184, by + boardH / 2);

    // Stoppage time indicator badge
    if ((state.half === 1 && min >= 45) || (state.half === 2 && min >= 90)) {
      ctx.fillStyle = '#ffd700';
      ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('+2\'', bx + 226, by + boardH / 2);
    }

    // Score Team 1
    ctx.font = 'bold 18px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(state.score[1]), bx + 234, by + boardH / 2);

    // Team 1 Short & badge
    ctx.font = 'bold 14px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(short1, bx + boardW - 32, by + boardH / 2);

    ctx.fillStyle = TEAM_PRESETS[1]?.shirt || '#006437';
    ctx.beginPath();
    safeRoundRect(ctx, bx + boardW - 26, by + 9, 16, 16, 3);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Tournament tag above scoreboard
    ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText('WEBSOCCER CONSOLE CHAMPIONSHIP', W / 2, by - 5);
  }

  /** Bottom-Left Console Player Card with Power Gauge */
  drawPlayerCard(ctx, state) {
    const H = this.canvas.height;
    const team0 = state.teams[0];
    const ctrlIdx = team0.controlled;
    const p = team0.players[ctrlIdx];
    if (!p) return;

    const squad = team0.squad || [];
    const playerName = squad[ctrlIdx] || `${team0.name} #${ctrlIdx + 1}`;
    const role = p.role ? p.role.toUpperCase() : 'ATA';

    const cardX = 14;
    const cardY = H - 54;
    const cardW = 210;
    const cardH = 40;

    ctx.save();
    ctx.fillStyle = 'rgba(12, 22, 16, 0.82)';
    ctx.beginPath();
    safeRoundRect(ctx, cardX, cardY, cardW, cardH, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Position role badge
    const roleColors = { GK: '#ffd700', GOL: '#ffd700', DF: '#00f0ff', DM: '#00e5ff', MF: '#00ff88', AM: '#ffcc00', FW: '#ff3366' };
    const rCol = roleColors[role] || '#00ff88';
    ctx.fillStyle = rCol;
    ctx.beginPath();
    safeRoundRect(ctx, cardX + 8, cardY + 8, 30, 14, 3);
    ctx.fill();

    ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0a1a0f';
    ctx.fillText(role, cardX + 23, cardY + 15);

    // Player Number & Name
    ctx.font = 'bold 12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(playerName, cardX + 44, cardY + 15);

    // Power gauge meter
    const gaugeW = cardW - 16;
    const gaugeH = 8;
    const gaugeX = cardX + 8;
    const gaugeY = cardY + 25;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(gaugeX, gaugeY, gaugeW, gaugeH);

    if (p.charging && p.charge > 0) {
      const frac = clamp(p.charge / CHARGE_MAX, 0, 1);
      const fillW = gaugeW * frac;
      const gColor = frac > 0.8 ? '#ff2244' : frac > 0.4 ? '#ffd700' : '#00f0ff';
      ctx.fillStyle = gColor;
      ctx.fillRect(gaugeX, gaugeY, fillW, gaugeH);
    } else {
      // Default idle stamina level
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(gaugeX, gaugeY, gaugeW * 0.9, gaugeH * 0.5);
    }

    ctx.restore();
  }

  drawNetStatus(ctx, net) {
    const H = this.canvas.height;
    ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const quality = net.ping < 60 ? '#00ff88' : net.ping < 140 ? '#ffd93c' : '#ff5a5a';
    ctx.fillStyle = 'rgba(10, 20, 14, 0.75)';
    ctx.beginPath();
    safeRoundRect(ctx, 8, H - 76, 116, 18, 3);
    ctx.fill();

    ctx.fillStyle = quality;
    ctx.fillText(`ONLINE  ${net.ping} ms`, 14, H - 67);

    if (net.stalling && !net.peerLeft && !net.desync) {
      const W = this.canvas.width;
      const text = 'AGUARDANDO ADVERSÁRIO';
      ctx.font = 'bold 14px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      const w = ctx.measureText(text).width + 24;
      ctx.fillStyle = 'rgba(10, 20, 14, 0.85)';
      ctx.fillRect(W / 2 - w / 2, H - 62, w, 26);
      ctx.fillStyle = '#ffd93c';
      ctx.fillText(text, W / 2, H - 49);
    }
  }

  /** Console Rounded Radar (Bottom-Right HUD) */
  drawRadar(ctx, state) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const rw = 84;
    const rh = rw * (WORLD_H / WORLD_W);
    const rx = W - rw - 14;
    const ry = H - rh - 14;

    ctx.save();
    ctx.fillStyle = 'rgba(8, 16, 11, 0.78)';
    ctx.beginPath();
    safeRoundRect(ctx, rx - 3, ry - 3, rw + 6, rh + 6, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(26, 92, 43, 0.85)';
    ctx.fillRect(rx, ry, rw, rh);

    const sx = rw / WORLD_W;
    const sy = rh / WORLD_H;

    // Pitch touchline & halfway line on radar
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + FIELD.left * sx, ry + FIELD.top * sy, (FIELD.right - FIELD.left) * sx, FIELD_H * sy);
    ctx.beginPath();
    ctx.moveTo(rx + FIELD.left * sx, ry + FIELD.cy * sy);
    ctx.lineTo(rx + FIELD.right * sx, ry + FIELD.cy * sy);
    ctx.stroke();

    // Player blips
    for (let t = 0; t < 2; t++) {
      ctx.fillStyle = TEAM_PRESETS[t]?.shirt || (t === 0 ? '#ffffff' : '#006437');
      for (const p of state.teams[t].players) {
        ctx.fillRect(rx + p.x * sx - 1, ry + p.y * sy - 1, 2.5, 2.5);
      }
    }

    // Ball blip (pulsing white)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rx + state.ball.x * sx - 1.2, ry + state.ball.y * sy - 1.2, 3, 3);

    // Camera viewport box
    const vw = (this.canvas.width / ZOOM) * sx;
    const vh = (this.canvas.height / ZOOM) * sy;
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.75)';
    ctx.strokeRect(rx + this.cam.x * sx - vw / 2, ry + this.cam.y * sy - vh / 2, vw, vh);

    ctx.restore();
  }

  /** Broadcast Lower-Third & Announcement Banners */
  drawMessage(ctx, state, net) {
    if (!state.message) return;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // GOAL Broadcast Lower-Third Celebration Graphic
    if (state.phase === 'goal') {
      const bannerW = 440;
      const bannerH = 74;
      const bx = W / 2 - bannerW / 2;
      const by = H / 2 - 70;

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
      ctx.shadowBlur = 18;

      const grad = makeGradient(ctx, bx, by, bx, by + bannerH, [[0, '#1a1005'], [0.5, '#2e1c08'], [1, '#0f0802']], '#1a1005');
      ctx.fillStyle = grad;
      ctx.beginPath();
      safeRoundRect(ctx, bx, by, bannerW, bannerH, 8);
      ctx.fill();

      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      ctx.font = 'bold 36px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffd700';
      ctx.fillText('G O L !', W / 2, by + 26);

      const scoringTeam = state.teams[state.lastGoalTeam];
      const scorer = this.stats.goals.length ? this.stats.goals[this.stats.goals.length - 1] : null;
      const subText = scorer
        ? `${scoringTeam.name.toUpperCase()} • ${scorer.scorer} ${scorer.minute}'`
        : `${scoringTeam.name.toUpperCase()} MARCOU!`;

      ctx.font = 'bold 15px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(subText, W / 2, by + 54);
      return;
    }

    // Standard Referee / Whistle Broadcast Banner
    if (state.phase !== 'fulltime' && state.phase !== 'halftime') {
      const bannerW = 280;
      const bannerH = 38;
      const bx = W / 2 - bannerW / 2;
      const by = 80;

      ctx.save();
      ctx.fillStyle = 'rgba(8, 16, 12, 0.88)';
      ctx.beginPath();
      safeRoundRect(ctx, bx, by, bannerW, bannerH, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      ctx.font = 'bold 15px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#00f0ff';
      ctx.fillText(state.message, W / 2, by + bannerH / 2);
    }
  }

  /** Half-Time & Full-Time Console Match Summary Screen */
  drawMatchSummary(ctx, state) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cardW = 460;
    const cardH = 320;
    const cx = W / 2 - cardW / 2;
    const cy = H / 2 - cardH / 2;

    ctx.save();
    // Backdrop blur effect
    ctx.fillStyle = 'rgba(4, 10, 8, 0.72)';
    ctx.fillRect(0, 0, W, H);

    // Main Card
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 24;
    const grad = makeGradient(ctx, cx, cy, cx, cy + cardH, [[0, '#101e18'], [1, '#070f0b']], '#101e18');
    ctx.fillStyle = grad;
    ctx.beginPath();
    safeRoundRect(ctx, cx, cy, cardW, cardH, 8);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Title
    const isEnd = state.phase === 'fulltime';
    const title = isEnd ? 'FIM DE JOGO • ESTATÍSTICAS' : 'INTERVALO • ESTATÍSTICAS';
    ctx.font = 'bold 14px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#00f0ff';
    ctx.fillText(title, W / 2, cy + 26);

    // Scoreboard header
    const t0 = state.teams[0];
    const t1 = state.teams[1];
    ctx.font = 'bold 26px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${t0.name}  ${state.score[0]} - ${state.score[1]}  ${t1.name}`, W / 2, cy + 60);

    // Calculate Possession Percentage
    const totalPoss = this.stats.possessionTicks[0] + this.stats.possessionTicks[1];
    const poss0 = Math.round((this.stats.possessionTicks[0] / Math.max(1, totalPoss)) * 100);
    const poss1 = 100 - poss0;

    // Comparison rows
    const rows = [
      { label: 'Posse de Bola', v0: `${poss0}%`, v1: `${poss1}%`, f0: poss0, f1: poss1 },
      { label: 'Finalizações', v0: this.stats.shots[0], v1: this.stats.shots[1], f0: this.stats.shots[0], f1: this.stats.shots[1] },
      { label: 'Chutes a Gol', v0: this.stats.shotsOnTarget[0], v1: this.stats.shotsOnTarget[1], f0: this.stats.shotsOnTarget[0], f1: this.stats.shotsOnTarget[1] },
      { label: 'Desarmes', v0: this.stats.tackles[0], v1: this.stats.tackles[1], f0: this.stats.tackles[0], f1: this.stats.tackles[1] },
      { label: 'Escanteios', v0: this.stats.corners[0], v1: this.stats.corners[1], f0: this.stats.corners[0], f1: this.stats.corners[1] },
    ];

    let rowY = cy + 96;
    for (const r of rows) {
      // Labels and numbers
      ctx.font = 'bold 12px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(r.v0), cx + 30, rowY + 12);

      ctx.textAlign = 'center';
      ctx.fillStyle = '#9fc7a8';
      ctx.fillText(r.label, W / 2, rowY + 12);

      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(r.v1), cx + cardW - 30, rowY + 12);

      // Comparative horizontal bars
      const barW = 120;
      const barH = 5;
      const barMid = W / 2;
      const tot = (r.f0 + r.f1) || 1;
      const len0 = (r.f0 / tot) * barW;
      const len1 = (r.f1 / tot) * barW;

      ctx.fillStyle = TEAM_PRESETS[0]?.shirt || '#00f0ff';
      ctx.fillRect(barMid - 5 - len0, rowY + 18, len0, barH);

      ctx.fillStyle = TEAM_PRESETS[1]?.shirt || '#ff3366';
      ctx.fillRect(barMid + 5, rowY + 18, len1, barH);

      rowY += 34;
    }

    // Console footer prompt
    ctx.font = 'bold 13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd700';
    ctx.fillText('Pressione [ENTER] ou Botão [A] para Continuar', W / 2, cy + cardH - 18);
  }
}

export function matchMinute(state) {
  const frac = clamp(state.halfTick / state.config.halfTicks, 0, 1);
  return Math.floor((state.half - 1) * 45 + frac * 45);
}
