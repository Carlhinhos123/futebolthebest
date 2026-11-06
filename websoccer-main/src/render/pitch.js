import {
  ARC_R, CENTER_R, CORNER_R, FIELD, FIELD_H, FIELD_W, GOAL_DEPTH, GOAL_W,
  PEN_D, PEN_SPOT, PEN_W, SIX_D, SIX_W, WORLD_H, WORLD_W,
} from '../constants.js';

// The pitch never changes, so we draw it once onto an offscreen canvas and then
// only blit the visible part.

export function buildPitch() {
  const c = document.createElement('canvas');
  c.width = WORLD_W;
  c.height = WORLD_H;
  const g = c.getContext('2d');

  // Outer stadium surround / running track area
  g.fillStyle = '#14381e';
  g.fillRect(0, 0, WORLD_W, WORLD_H);

  // Perimeter LED boards along top and bottom
  const ledH = 14;
  g.fillStyle = '#0a1a12';
  g.fillRect(FIELD.left - 24, FIELD.top - ledH - 10, FIELD_W + 48, ledH);
  g.fillRect(FIELD.left - 24, FIELD.bottom + 10, FIELD_W + 48, ledH);

  // LED board text & accents
  g.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = '#00f0ff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const sponsors = ['WEBSOCCER CONSOLE', 'SENAI CHAMPIONSHIP', 'VIBE ARENA', 'FAIR PLAY', 'GOAL TECH'];
  for (let i = 0; i < sponsors.length; i++) {
    const sx = FIELD.left + 40 + i * ((FIELD_W - 80) / (sponsors.length - 1));
    g.fillStyle = i % 2 === 0 ? '#00f0ff' : '#ffd700';
    g.fillText(sponsors[i], sx, FIELD.top - ledH / 2 - 10);
    g.fillText(sponsors[i], sx, FIELD.bottom + 10 + ledH / 2);
  }

  // Sideline technical area boxes
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 1.5;
  g.strokeRect(FIELD.left - 30, FIELD.cy - 120, 18, 100);
  g.strokeRect(FIELD.left - 30, FIELD.cy + 20, 18, 100);

  // Luxury pitch grass with alternating championship cut stripes
  const stripe = 56;
  for (let y = FIELD.top; y < FIELD.bottom; y += stripe) {
    const i = Math.floor((y - FIELD.top) / stripe);
    g.fillStyle = i % 2 ? '#227835' : '#1c692d';
    const h = Math.min(stripe, FIELD.bottom - y);
    g.fillRect(FIELD.left, y, FIELD_W, h);

    // Fine turf mower pass lines
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.03)';
    g.fillRect(FIELD.left, y + h / 2, FIELD_W, h / 2);
  }

  // Subtle stadium floodlight pitch vignette
  try {
    const radGrad = g.createRadialGradient ? g.createRadialGradient(FIELD.cx, FIELD.cy, 120, FIELD.cx, FIELD.cy, FIELD_H * 0.75) : null;
    if (radGrad && typeof radGrad.addColorStop === 'function') {
      radGrad.addColorStop(0, 'rgba(255,255,255,0.05)');
      radGrad.addColorStop(0.7, 'rgba(0,0,0,0)');
      radGrad.addColorStop(1, 'rgba(0,0,0,0.22)');
      g.fillStyle = radGrad;
      g.fillRect(FIELD.left, FIELD.top, FIELD_W, FIELD_H);
    }
  } catch {
    /* Safe fallback if canvas gradient unsupported */
  }

  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.lineWidth = 3.5;
  g.lineCap = 'butt';

  // Touchlines and goal lines
  g.strokeRect(FIELD.left, FIELD.top, FIELD_W, FIELD_H);

  // Halfway line + centre circle
  line(g, FIELD.left, FIELD.cy, FIELD.right, FIELD.cy);
  circle(g, FIELD.cx, FIELD.cy, CENTER_R);
  dot(g, FIELD.cx, FIELD.cy);

  for (const side of [-1, 1]) {
    const gy = side < 0 ? FIELD.top : FIELD.bottom;
    const dir = side < 0 ? 1 : -1;

    // Penalty area
    g.strokeRect(FIELD.cx - PEN_W / 2, side < 0 ? gy : gy - PEN_D, PEN_W, PEN_D);
    // Six-yard box
    g.strokeRect(FIELD.cx - SIX_W / 2, side < 0 ? gy : gy - SIX_D, SIX_W, SIX_D);
    // Penalty spot
    dot(g, FIELD.cx, gy + dir * PEN_SPOT);

    // Arc outside the penalty area
    g.save();
    g.beginPath();
    if (side < 0) g.rect(FIELD.left, gy + PEN_D, FIELD_W, 200);
    else g.rect(FIELD.left, gy - PEN_D - 200, FIELD_W, 200);
    g.clip();
    circle(g, FIELD.cx, gy + dir * PEN_SPOT, ARC_R);
    g.restore();

    // Corner arcs
    for (const sx of [-1, 1]) {
      const cxp = sx < 0 ? FIELD.left : FIELD.right;
      g.beginPath();
      g.arc(cxp, gy, CORNER_R, 0, Math.PI * 2);
      g.stroke();
    }

    // Goal + 3D depth net
    const gx0 = FIELD.cx - GOAL_W / 2;
    const gy0 = side < 0 ? gy - GOAL_DEPTH : gy;
    g.save();
    g.fillStyle = 'rgba(255,255,255,0.09)';
    g.fillRect(gx0, gy0, GOAL_W, GOAL_DEPTH);

    // Net mesh grid
    g.strokeStyle = 'rgba(255,255,255,0.30)';
    g.lineWidth = 1;
    for (let x = gx0; x <= gx0 + GOAL_W; x += 6) line(g, x, gy0, x, gy0 + GOAL_DEPTH);
    for (let y = gy0; y <= gy0 + GOAL_DEPTH; y += 6) line(g, gx0, y, gx0 + GOAL_W, y);

    // Diagonal depth support chords
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.lineWidth = 1.5;
    line(g, gx0, gy, gx0, gy0);
    line(g, gx0 + GOAL_W, gy, gx0 + GOAL_W, gy0);

    // Goal frame
    g.strokeStyle = '#ffffff';
    g.lineWidth = 4;
    g.strokeRect(gx0, gy0, GOAL_W, GOAL_DEPTH);
    g.restore();
  }

  // Corner flags
  drawCornerFlags(g);

  return c;
}

function drawCornerFlags(g) {
  const corners = [
    { x: FIELD.left, y: FIELD.top, dx: -1, dy: -1 },
    { x: FIELD.right, y: FIELD.top, dx: 1, dy: -1 },
    { x: FIELD.left, y: FIELD.bottom, dx: -1, dy: 1 },
    { x: FIELD.right, y: FIELD.bottom, dx: 1, dy: 1 },
  ];
  for (const c of corners) {
    // Flag pole
    g.strokeStyle = '#f5f5f5';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(c.x, c.y);
    g.lineTo(c.x, c.y - 12);
    g.stroke();

    // Vibrant console flag cloth
    g.fillStyle = '#ffcc00';
    g.beginPath();
    g.moveTo(c.x, c.y - 12);
    g.lineTo(c.x + c.dx * 8, c.y - 9);
    g.lineTo(c.x, c.y - 6);
    g.closePath();
    g.fill();
    g.fillStyle = '#ff2222';
    g.beginPath();
    g.moveTo(c.x, c.y - 10);
    g.lineTo(c.x + c.dx * 5, c.y - 8);
    g.lineTo(c.x, c.y - 6);
    g.closePath();
    g.fill();
  }
}

function line(g, x0, y0, x1, y1) {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

function circle(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
}

function dot(g, x, y) {
  g.beginPath();
  g.arc(x, y, 2.5, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
}
