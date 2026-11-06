import {
  ALL_TEAMS, BTN, CHARGE_MAX, FRAME_TIME, TICK_RATE, TEAM_PRESETS, applyTeam,
} from './constants.js';
import {
  ACTIONS, ACTION_LABELS, InputDevices, PRESETS, findConflicts, keyLabel, loadBindings, saveBindings,
} from './input.js';
import { createMatch } from './game/state.js';
import {
  DEFAULT_KEY, PRESETS as LINEUP_PRESETS, lineupFrom, presetFor, shapeOf,
} from './game/formations.js';
import { LineupEditor } from './lineupEditor.js';
import { NAME_LENGTH, Highscores, placeOf } from './highscores.js';
import { NameEntry } from './nameEntry.js';
import { boardFor, relayFor } from './config.js';
import { step } from './game/sim.js';
import { Renderer } from './render/renderer.js';
import { drawTitleScreen } from './render/titlescreen.js';
import { LocalTransport, OnlineTransport } from './net/transport.js';
import { Signal } from './net/signal.js';
import { AudioEngine, Chiptune, Sfx } from './audio.js';
import { Speech } from './speech.js';
import * as commentary from './commentary.js';
import { TouchControls, isTouchDevice } from './touch.js';

const canvas = document.getElementById('game');
const menu = document.getElementById('menu');
const pauseBox = document.getElementById('pause');
const netendBox = document.getElementById('netend');
const localSetup = document.getElementById('localSetup');
const onlineSetup = document.getElementById('onlineSetup');
const onlineStatus = document.getElementById('onlineStatus');
const roomCode = document.getElementById('roomCode');
const difficultyRow = document.getElementById('difficultyRow');

const audio = new AudioEngine();
const music = new Chiptune(audio);
const speech = new Speech(audio, commentary);
const sfx = new Sfx(audio, speech);
sfx.talking = globalThis.localStorage?.getItem('websoccer.commentary') !== 'off';
let soundOn = globalThis.localStorage?.getItem('websoccer.music') !== 'off';
audio.enabled = soundOn;

// Named now that a second game shares this domain. The old key is kept, so
// nobody's keys are forgotten.
const KEYS_STORAGE = 'websoccer.bindings';
const bindings = loadBindings(KEYS_STORAGE);
const devices = new InputDevices(bindings);
devices.attach();

function goFullscreen() {
  try {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  } catch {}
}

const touch = new TouchControls();
devices.touch = touch;

let touchControlsEnabled = (() => {
  try {
    const saved = localStorage.getItem('websoccer.showTouch');
    if (saved !== null) return saved === 'true';
  } catch {}
  return true;
})();

const touchElements = {
  root: document.getElementById('touch'),
  stick: document.getElementById('touchStick'),
  knob: document.getElementById('touchKnob'),
  kick: document.getElementById('touchKick'),
  swap: document.getElementById('touchSwap'),
};

if (touchElements.root && touchElements.stick && touchElements.knob && touchElements.kick && touchElements.swap) {
  touch.attach(touchElements);
}

function updateHudToggleUI() {
  const btn = document.getElementById('hudToggleBtn');
  if (btn) {
    btn.textContent = touchControlsEnabled ? '🎮 BOTÕES NA TELA: LIGADO' : '🎮 BOTÕES NA TELA: DESLIGADO';
    btn.classList.toggle('active', touchControlsEnabled);
  }
  const inGameBtn = document.getElementById('btnTouchToggle');
  if (inGameBtn) {
    inGameBtn.textContent = touchControlsEnabled ? '🎮 BOTÕES: ON' : '🎮 BOTÕES: OFF';
    inGameBtn.classList.toggle('active', touchControlsEnabled);
  }
}

function toggleTouchControls() {
  touchControlsEnabled = !touchControlsEnabled;
  try {
    localStorage.setItem('websoccer.showTouch', String(touchControlsEnabled));
  } catch {}
  updateHudToggleUI();
  if (game.state && menu.classList.contains('hidden')) {
    touch.show(touchControlsEnabled);
  }
}

document.getElementById('hudToggleBtn')?.addEventListener('click', toggleTouchControls);
document.getElementById('btnTouchToggle')?.addEventListener('click', toggleTouchControls);
updateHudToggleUI();

const ua = globalThis.navigator?.userAgent || '';
const onIOS = /iPad|iPhone|iPod/.test(ua)
  || (globalThis.navigator?.platform === 'MacIntel' && globalThis.navigator?.maxTouchPoints > 1);
if (onIOS) {
  const hint = document.getElementById('iosHint');
  if (hint) hint.classList.add('hidden');
}

const renderer = new Renderer(canvas);

// Named explicitly now that a second game shares this domain: without it both
// games would read and write the same table.
const highscores = new Highscores(globalThis.localStorage, 'websoccer.highscores.v1');
const hiscoreBox = document.getElementById('hiscore');

const game = {
  state: null,
  transport: null,
  signal: null,
  paused: false,
  acc: 0,
  last: performance.now(),
  ended: false,
};

// --- Starting a match -------------------------------------------------------

function beginMatch(state, transport) {
  game.state = state;
  game.transport = transport;
  game.paused = false;
  game.ended = false;
  game.acc = 0;
  game.last = performance.now();
  renderer.resetStats();
  sfx.menuSelect();
  renderer.updateCamera(state, true);

  menu.classList.add('hidden');
  pauseBox.classList.add('hidden');
  netendBox.classList.add('hidden');
  canvas.focus();
  if (touchControlsEnabled) {
    touch.show(true);
    document.getElementById('touch')?.classList.toggle('online', !!transport.online);
  } else {
    touch.show(false);
  }
  music.stop(); // title tune only: nobody wants a loop over ninety minutes
}

function startLocal({ players, halfSeconds }) {
  const state = createMatch({
    seed: (Date.now() & 0x7fffffff) || 1,
    halfSeconds,
    humans: [true, players === 2],
    difficulty,
    offside,
    formations: [lineups[0].spots, lineups[1].spots],
  });
  beginMatch(state, new LocalTransport(devices, players === 2 ? [0, 1] : [0]));
}

function startOnline(opts) {
  const { seed, halfSeconds, localTeam, signal } = opts;
  // Both teams are "human": no CPU, and exactly the same simulation on both
  // sides. Only the seed and the team assignment come from the host.
  const state = createMatch({
    seed, halfSeconds, humans: [true, true], offside: opts.offside, formations: opts.formations,
  });
  const transport = new OnlineTransport({ signal, devices, localTeam });
  beginMatch(state, transport);
}

function toMenu() {
  if (game.transport) game.transport.dispose();
  else if (game.signal) game.signal.close();
  sfx.menuCancel();
  game.state = null;
  game.transport = null;
  game.signal = null;
  menu.classList.remove('hidden');
  pauseBox.classList.add('hidden');
  netendBox.classList.add('hidden');
  touch.show(false);
  if (soundOn) music.start();
  setOnlineStatus('');
  roomCode.classList.add('hidden');
  document.getElementById('host').disabled = false;
}

// --- Game loop --------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = Math.min(0.25, (now - game.last) / 1000);
  game.last = now;

  const nav = devices.pollMenuNav();

  if (!game.state) {
    if (nav.prevTab) cycleTeam(0, -1);
    if (nav.nextTab) cycleTeam(1, 1);
    if (nav.confirm) {
      const startBtn = document.getElementById('start');
      if (startBtn && !startBtn.classList.contains('hidden') && !startBtn.disabled) {
        startBtn.click();
      }
    }
    // Nothing to simulate yet, so the canvas shows the title picture instead of
    // an empty green field behind the menu.
    drawTitleScreen(renderer.ctx, canvas.width, canvas.height);
    return;
  }

  // In match: Gamepad pause support
  if (nav.pause && !game.transport.online) {
    setPaused(!game.paused);
  }

  if (!game.paused) {
    game.acc += elapsed;

    let guard = 0;
    const events = [];
    while (game.acc >= FRAME_TIME && guard < 8) {
      const tick = game.state.tick;

      // Always record and send our own input first - even when we have to wait
      // ourselves. Otherwise two waiting players would block each other.
      game.transport.sample(tick);

      if (!game.transport.ready(tick)) break;

      step(game.state, game.transport.poll(tick));
      game.transport.afterStep(game.state);
      // Collected here, because the next tick clears the list.
      if (game.state.events.length) events.push(...game.state.events);
      game.acc -= FRAME_TIME;
      guard++;
    }
    if (events.length) sfx.play(events);

    // Do not let the backlog grow: after a hiccup we catch up a few ticks, but
    // we never fast-forward through ten seconds of football.
    if (guard >= 8 || game.acc > FRAME_TIME * 8) game.acc = Math.min(game.acc, FRAME_TIME * 8);
  }

  renderer.draw(game.state, netInfo());
  checkNetEnd();

  // Keep HUD on-screen controls in sync with active player charge and inputs
  if (touchControlsEnabled && game.state && !game.paused) {
    const fireDown = devices.isDown('Space') || ((devices.lookup[0]?.Space || 0) & BTN.FIRE) || (devices.gamepadMask(0) & BTN.FIRE);
    const swapDown = devices.isDown('KeyQ') || ((devices.lookup[0]?.KeyQ || 0) & BTN.SWITCH) || (devices.gamepadMask(0) & BTN.SWITCH);
    if (fireDown) touchElements.kick?.classList.add('pressed');
    else if (!touch.mask || !(touch.mask & BTN.FIRE)) touchElements.kick?.classList.remove('pressed');

    if (swapDown) touchElements.swap?.classList.add('pressed');
    else if (!touch.mask || !(touch.mask & BTN.SWITCH)) touchElements.swap?.classList.remove('pressed');

    const t = 0;
    const team = game.state.teams[t];
    const p = team?.players[team.controlled];
    const chargeBar = document.getElementById('touchChargeBar');
    if (chargeBar && p) {
      if (p.charging && p.charge > 0) {
        const pct = Math.min(100, Math.round((p.charge / CHARGE_MAX) * 100));
        chargeBar.style.width = `${pct}%`;
        chargeBar.style.background = pct > 85 ? '#ff3344' : pct > 45 ? '#ffd700' : '#00e5ff';
      } else {
        chargeBar.style.width = '0%';
      }
    }
  }

  if (game.state.phase === 'halftime' && !game.transport.online) {
    if (devices.isDown('Enter') || devices.isDown('Space') || nav.confirm) {
      if (game.state.phaseTimer > 8) game.state.phaseTimer = 8;
    }
  }

  if (game.state.phase === 'fulltime' && !game.transport.online) {
    // The table comes first: pressing Enter to leave must not skip past the one
    // moment you earned.
    if (offerHighscore()) return;
    if (devices.isDown('Enter') || devices.isDown('Space') || nav.confirm) toMenu();
  }
}

// --- High scores -------------------------------------------------------------

const nameEntry = new NameEntry(document.getElementById('hiscoreLetters'), (name) => {
  try {
    globalThis.localStorage?.setItem('websoccer.name', name);
  } catch { /* the name just will not stick */ }
  const place = highscores.add(pending.difficulty, { ...pending.entry, name });
  pending.freshId = pending.entry.id;
  pending.open = false;
  hiscoreBox.classList.add('hidden');
  renderScores(pending.difficulty, place);
  document.getElementById('scoresBox').open = true;
  toMenu();
  syncScores();
});

const pending = { open: false, entry: null, difficulty: 'normal', freshId: null };

// Typing beats hunting for letters with the stick, so it is offered as well.
// Captured before the key bindings see it: while the picker is up, the keyboard
// belongs to the picker.
window.addEventListener('keydown', (e) => {
  if (!pending.open) return;
  if (nameEntry.type(e.key)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

/**
 * The same picker, with something to press.
 *
 * The three letters are driven by the game's own stick and confirm button, which
 * is right on a cabinet and on a keyboard and is nothing at all on a phone:
 * those controls live at the bottom of the screen, this panel is laid over the
 * top of them, and a tap lands on the panel. A score that had been earned
 * arrived at a screen with no way off it.
 *
 * So the picker gets arrows and an OK of its own. They drive the same object the
 * stick does rather than a second copy of the logic - nameEntry is one of the
 * files shared with the other games and is not any one game's to change - and
 * they are shown everywhere, because clicking an arrow beats finding the arrow
 * keys on a laptop too.
 */
for (let slot = 0; slot < NAME_LENGTH; slot++) {
  for (const [row, by, label] of [
    ['hiscoreUp', -1, '\u25B2'],
    ['hiscoreDown', 1, '\u25BC'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      nameEntry.slot = slot;
      nameEntry.cycle(by);
      nameEntry.render();
      // Otherwise the button keeps focus and the next Space presses it again
      // instead of confirming.
      button.blur();
    });
    document.getElementById(row).appendChild(button);
  }
}

// Tapping a letter moves to it, which is what everybody tries first.
document.getElementById('hiscoreLetters').addEventListener('click', (e) => {
  const at = [...e.currentTarget.children].indexOf(e.target);
  if (at < 0) return;
  nameEntry.slot = at;
  nameEntry.render();
});

document.getElementById('hiscoreOk').addEventListener('click', () => {
  nameEntry.confirm();
});


/**
 * Called every frame once a local match is over. Puts the three letter picker
 * up if the result earned a place, and drives it from the same input mask the
 * match used, so the stick and the kick button work on a phone.
 */
function offerHighscore() {
  if (pending.open) {
    nameEntry.step(devices.mask(0));
    return true;
  }
  // Two players on one keyboard, or an online match, are not a score anybody
  // set on their own.
  if (game.ended || game.transport.humanSlots?.length !== 1) return false;
  game.ended = true; // whatever happens next, we only offer once

  const entry = {
    id: undefined,
    name: lastName(),
    scored: game.state.score[0],
    conceded: game.state.score[1],
    halfSeconds: Math.round(game.state.config.halfTicks / TICK_RATE),
    at: Date.now(),
  };
  if (!highscores.qualifies(difficulty, entry)) return false;

  const place = placeOf(highscores.table(difficulty), entry);
  pending.entry = { ...entry, id: undefined };
  pending.difficulty = difficulty;
  pending.open = true;
  document.getElementById('hiscoreLine').textContent
    = `${game.state.score[0]} - ${game.state.score[1]} against ${difficulty.toUpperCase()}: number ${place}`;
  hiscoreBox.classList.remove('hidden');
  // Out of the way while the picker is up. They sit under this panel and
  // cannot be reached anyway, and a control showing through an overlay that
  // swallows every tap is worse than no control at all.
  touch.show(false);
  nameEntry.start(lastName());
  return true;
}

function lastName() {
  try {
    return globalThis.localStorage?.getItem('websoccer.name') || 'AAA';
  } catch {
    return 'AAA';
  }
}

/**
 * Trades boards with the relay: we send ours, it merges and sends back the lot.
 * One request in each direction would race - two devices posting at once would
 * each overwrite the other - so the merge happens on the server, using the same
 * function this page uses, and the answer is merged in here again.
 *
 * Failure is not an error. No relay configured, offline, server asleep: you keep
 * your own table and nobody hears about it.
 */
async function syncScores() {
  const url = boardFor(location);
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board: highscores.all() }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data?.board) return false;
    highscores.absorb(data.board);
    renderScores(difficulty);
    return true;
  } catch {
    return false;
  }
}

function renderScores(level, freshPlace = 0) {
  const body = document.getElementById('scoresBody');
  document.getElementById('scoresLevel').textContent = level.toUpperCase();
  body.innerHTML = '';
  const rows = highscores.table(level);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tr = document.createElement('tr');
    if (i + 1 === freshPlace) tr.className = 'fresh';
    const cells = [
      ['place', `${i + 1}`],
      ['name', row.name],
      ['result', `${row.scored} - ${row.conceded}`],
      ['when', new Date(row.at).toLocaleDateString()],
    ];
    for (const [cls, text] of cells) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  document.getElementById('scoresNote').textContent = rows.length
    ? 'Biggest win first. Beat the CPU to get on the board - a draw counts, a defeat does not.'
    : 'Nothing here yet. Beat the CPU at this level and the board is yours.';
}

function netInfo() {
  const t = game.transport;
  if (!t || !t.online) return null;
  return {
    online: true,
    ping: t.ping,
    stalling: t.stalling,
    desync: t.desync,
    peerLeft: t.peerLeft,
    team: t.localTeam,
  };
}

function checkNetEnd() {
  const t = game.transport;
  if (!t || !t.online || game.ended) return;

  const finished = game.state.phase === 'fulltime';
  if (!t.peerLeft && !t.desync && !finished) return;

  let title;
  let text;
  if (t.desync) {
    title = 'DESYNC';
    text = 'The two players computed a different match state. The match has been stopped.';
  } else if (t.peerLeft) {
    title = 'OPPONENT GONE';
    text = 'The connection to your opponent has been lost.';
  } else {
    title = 'FULL TIME';
    text = `${game.state.teams[0].name} ${game.state.score[0]} - ${game.state.score[1]} ${game.state.teams[1].name}`;
  }

  game.ended = true;
  document.getElementById('netendTitle').textContent = title;
  document.getElementById('netendText').textContent = text;
  netendBox.classList.remove('hidden');
}

// --- Controls -----------------------------------------------------------------

const keysBody = document.getElementById('keysBody');
const bindHint = document.getElementById('bindHint');
let listeningFor = null; // {slot, action} while waiting for a key to be pressed

function setBindHint(text, warn = false) {
  bindHint.textContent = text;
  bindHint.classList.toggle('warn', warn);
}

function renderBindings() {
  const clashing = new Set();
  for (const clash of findConflicts(bindings)) {
    clashing.add(`${clash.a.slot}:${clash.a.action}`);
    clashing.add(`${clash.b.slot}:${clash.b.action}`);
  }

  keysBody.innerHTML = '';
  for (const action of ACTIONS) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = ACTION_LABELS[action];
    row.appendChild(name);

    for (let slot = 0; slot < 2; slot++) {
      const cell = document.createElement('td');
      const button = document.createElement('button');
      const id = `${slot}:${action}`;
      button.className = 'bind';
      button.dataset.bind = id;
      button.textContent = listeningFor && listeningFor.slot === slot && listeningFor.action === action
        ? 'press a key'
        : keyLabel(bindings[slot][action]);
      if (listeningFor && button.textContent === 'press a key') button.classList.add('listening');
      if (clashing.has(id)) button.classList.add('clash');
      button.addEventListener('click', () => startListening(slot, action));
      cell.appendChild(button);
      row.appendChild(cell);
    }
    keysBody.appendChild(row);
  }

  for (const select of document.querySelectorAll('[data-preset]')) {
    const slot = Number(select.dataset.preset);
    const current = PRESETS.find((p) => ACTIONS.every((a) => p.bindings[a] === bindings[slot][a]));
    select.innerHTML = '';
    for (const preset of PRESETS) {
      const option = document.createElement('option');
      option.value = preset.key;
      option.textContent = preset.label;
      if (current && current.key === preset.key) option.selected = true;
      select.appendChild(option);
    }
    if (!current) {
      const option = document.createElement('option');
      option.value = 'custom';
      option.textContent = 'Custom';
      option.selected = true;
      select.appendChild(option);
    }
  }

  if (clashing.size) {
    setBindHint('Those keys overlap. Fine for one player, but two players need separate keys.', true);
  } else if (!listeningFor) {
    setBindHint('Click a key to change it.');
  }
}

function startListening(slot, action) {
  listeningFor = { slot, action };
  setBindHint('Press the key you want to use, or Escape to cancel.');
  renderBindings();
}

function applyKey(code) {
  const { slot, action } = listeningFor;
  listeningFor = null;
  bindings[slot][action] = code;
  devices.setBindings(bindings);
  devices.down.clear(); // the key we just captured never gets a keyup we care about
  saveBindings(bindings, KEYS_STORAGE);
  renderBindings();
}

// Capture phase, and always prevented: otherwise pressing Space would activate
// the button that is still focused and immediately ask for another key.
window.addEventListener('keydown', (e) => {
  if (!listeningFor) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') {
    listeningFor = null;
    renderBindings();
    return;
  }
  applyKey(e.code);
}, true);

for (const select of document.querySelectorAll('[data-preset]')) {
  select.addEventListener('change', () => {
    const preset = PRESETS.find((p) => p.key === select.value);
    if (!preset) return;
    bindings[Number(select.dataset.preset)] = { ...preset.bindings };
    devices.setBindings(bindings);
    saveBindings(bindings, KEYS_STORAGE);
    renderBindings();
  });
}

renderBindings();

// --- Menu -------------------------------------------------------------------

let mode = '1';
let difficulty = 'normal';
let offside = true;

// --- Line-ups ---------------------------------------------------------------
//
// One per team, each either a preset or a set of spots you dragged yourself.
// Kept as spots rather than a key, so a custom line-up survives a reload and can
// be handed to the other machine in an online match without either side needing
// to agree on what "4-4-2 diamond" means.

const KITS = [TEAM_PRESETS[0]?.shirt || '#f5f5f5', TEAM_PRESETS[1]?.shirt || '#006437'];
const lineups = [readLineup(0), readLineup(1)];
let editing = 0;

function readLineup(slot) {
  try {
    const raw = globalThis.localStorage?.getItem(`websoccer.lineup.${slot}`);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && Array.isArray(saved.spots)) {
        return { key: saved.key || 'custom', spots: lineupFrom(saved.spots) };
      }
    }
  } catch { /* nothing saved, or private mode */ }
  return { key: DEFAULT_KEY, spots: lineupFrom(DEFAULT_KEY) };
}

function saveLineup(slot) {
  try {
    globalThis.localStorage?.setItem(`websoccer.lineup.${slot}`, JSON.stringify({
      key: lineups[slot].key,
      spots: lineups[slot].spots.map(({ x, y }) => ({ x, y })),
    }));
  } catch { /* the setting just will not stick */ }
}

const lineupPresets = document.getElementById('lineupPresets');
const lineupNote = document.getElementById('lineupNote');
const lineupShape = document.getElementById('lineupShape');
const editor = new LineupEditor(document.getElementById('lineupPitch'), (spots) => {
  lineups[editing] = { key: 'custom', spots: lineupFrom(spots) };
  saveLineup(editing);
  renderLineup();
});

for (const preset of LINEUP_PRESETS) {
  const btn = document.createElement('button');
  btn.textContent = preset.label;
  btn.dataset.lineup = preset.key;
  btn.addEventListener('click', () => {
    lineups[editing] = { key: preset.key, spots: lineupFrom(preset.key) };
    saveLineup(editing);
    renderLineup();
  });
  lineupPresets.appendChild(btn);
}

document.querySelectorAll('[data-lineupteam]').forEach((btn) => {
  btn.addEventListener('click', () => {
    editing = Number(btn.dataset.lineupteam);
    document.querySelectorAll('[data-lineupteam]').forEach((b) => b.classList.toggle('active', b === btn));
    renderLineup();
  });
});

function renderLineup() {
  const current = lineups[editing];
  editor.set(current.spots, KITS[editing]);
  lineupShape.textContent = shapeOf(current.spots);
  lineupNote.textContent = current.key === 'custom'
    ? 'Your own line-up. Pick a preset above to start again.'
    : presetFor(current.key).note;
  lineupPresets.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lineup === current.key);
  });
}

renderLineup();

// --- Console Team Selector --------------------------------------------------
const selectedTeams = [0, 1];

function updateTeamUI(slot) {
  const team = ALL_TEAMS[selectedTeams[slot]];
  if (!team) return;
  applyTeam(slot, team);
  KITS[slot] = TEAM_PRESETS[slot].shirt;

  const nameEl = document.getElementById(`teamName${slot}`);
  const shortEl = document.getElementById(`teamShort${slot}`);
  const kitEl = document.getElementById(`teamKit${slot}`);
  const ratingEl = document.getElementById(`teamRating${slot}`);

  if (nameEl) nameEl.textContent = team.name;
  if (shortEl) shortEl.textContent = team.short;
  if (kitEl) kitEl.style.backgroundColor = team.shirt;
  if (ratingEl) {
    const avg = Math.round((team.ratings.att + team.ratings.mid + team.ratings.def) / 3);
    ratingEl.textContent = `OVR ${avg}`;
  }

  // Update controls header
  const p1head = document.getElementById('p1head');
  const p2head = document.getElementById('p2head');
  if (p1head && slot === 0) p1head.textContent = `Player 1 (${team.name})`;
  if (p2head && slot === 1) p2head.textContent = `Player 2 (${team.name})`;

  // Update line-up editor labels
  const lineupTeamBtns = document.querySelectorAll('[data-lineupteam]');
  if (lineupTeamBtns[slot]) lineupTeamBtns[slot].textContent = team.name;

  renderLineup();
  renderer.rebuildPitch();
}

function cycleTeam(slot, dir) {
  selectedTeams[slot] = (selectedTeams[slot] + dir + ALL_TEAMS.length) % ALL_TEAMS.length;
  if (selectedTeams[0] === selectedTeams[1]) {
    selectedTeams[slot] = (selectedTeams[slot] + dir + ALL_TEAMS.length) % ALL_TEAMS.length;
  }
  updateTeamUI(slot);
  sfx.menuNav();
}

const prevTeam0 = document.getElementById('prevTeam0');
const nextTeam0 = document.getElementById('nextTeam0');
const prevTeam1 = document.getElementById('prevTeam1');
const nextTeam1 = document.getElementById('nextTeam1');

if (prevTeam0) prevTeam0.addEventListener('click', () => cycleTeam(0, -1));
if (nextTeam0) nextTeam0.addEventListener('click', () => cycleTeam(0, 1));
if (prevTeam1) prevTeam1.addEventListener('click', () => cycleTeam(1, -1));
if (nextTeam1) nextTeam1.addEventListener('click', () => cycleTeam(1, 1));

// Initialize default teams
updateTeamUI(0);
updateTeamUI(1);

// Fullscreen button
const fsBtn = document.getElementById('fsBtn');
if (fsBtn) {
  fsBtn.addEventListener('click', () => {
    sfx.menuSelect();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
      fsBtn.textContent = '✕ SAIR';
    } else {
      document.exitFullscreen?.().catch(() => {});
      fsBtn.textContent = '⛶ TELA CHEIA';
    }
  });
}

// Button sounds for navigation
document.querySelectorAll('button:not(#start):not(#host), select, summary').forEach((el) => {
  el.addEventListener('click', () => {
    sfx.menuNav();
  });
});

document.querySelectorAll('[data-music]').forEach((btn) => {
  btn.classList.toggle('active', (btn.dataset.music === 'on') === soundOn);
  btn.addEventListener('click', () => {
    soundOn = btn.dataset.music === 'on';
    document.querySelectorAll('[data-music]').forEach((b) => b.classList.toggle('active', b === btn));
    try {
      globalThis.localStorage?.setItem('websoccer.music', soundOn ? 'on' : 'off');
    } catch { /* private mode: the setting just will not stick */ }
    audio.enabled = soundOn;
    if (soundOn) audio.wake();
    music.toggle(soundOn && !game.state);
  });
});

document.querySelectorAll('[data-commentary]').forEach((btn) => {
  btn.classList.toggle('active', (btn.dataset.commentary === 'on') === sfx.talking);
  btn.addEventListener('click', () => {
    sfx.talking = btn.dataset.commentary === 'on';
    document.querySelectorAll('[data-commentary]').forEach((b) => b.classList.toggle('active', b === btn));
    try {
      globalThis.localStorage?.setItem('websoccer.commentary', sfx.talking ? 'on' : 'off');
    } catch { /* the setting just will not stick */ }
    // So you can hear what you just switched on.
    if (sfx.talking) {
      audio.wake();
      sfx.commentary('goal');
    }
  });
});

document.querySelectorAll('[data-offside]').forEach((btn) => {
  btn.addEventListener('click', () => {
    offside = btn.dataset.offside === 'on';
    document.querySelectorAll('[data-offside]').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

document.querySelectorAll('[data-difficulty]').forEach((btn) => {
  btn.addEventListener('click', () => {
    difficulty = btn.dataset.difficulty;
    document.querySelectorAll('[data-difficulty]').forEach((b) => b.classList.toggle('active', b === btn));
    renderScores(difficulty);
  });
});

renderScores(difficulty);
// Trades boards with the relay, if there is one, the moment the menu appears.
syncScores();

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    localSetup.classList.toggle('hidden', mode === 'online');
    onlineSetup.classList.toggle('hidden', mode !== 'online');
    // The two primary buttons live in the shared footer, so they are swapped
    // here rather than by hiding the panel around them.
    document.getElementById('start').classList.toggle('hidden', mode === 'online');
    document.getElementById('host').classList.toggle('hidden', mode !== 'online');
    renderBindings();
    // Only worth choosing when there is a CPU to play against.
    difficultyRow.classList.toggle('hidden', mode !== '1');
    // Online you only ever pick your own side, so the team switch goes away and
    // slot 0 is always "yours".
    document.getElementById('lineupTeamRow').classList.toggle('hidden', mode === 'online');
    if (mode === 'online' && editing !== 0) {
      editing = 0;
      document.querySelectorAll('[data-lineupteam]').forEach((b) => b.classList.toggle('active', b.dataset.lineupteam === '0'));
      renderLineup();
    }

    // Switching mode releases any room we had opened.
    if (game.signal && !game.state) {
      game.signal.close();
      game.signal = null;
      roomCode.classList.add('hidden');
      setOnlineStatus('');
      document.getElementById('host').disabled = false;
    }
  });
});

document.getElementById('start').addEventListener('click', () => {
  goFullscreen();
  const players = Number(mode);
  // Sharing keys is fine for one player, impossible for two.
  if (players === 2 && findConflicts(bindings).length) {
    setBindHint('Both players are using the same keys. Give them separate ones first.', true);
    return;
  }
  startLocal({ players, halfSeconds: halfSeconds() });
});

document.getElementById('resume').addEventListener('click', () => setPaused(false));

document.getElementById('quit').addEventListener('click', toMenu);
document.getElementById('netendQuit').addEventListener('click', toMenu);

function halfSeconds() {
  return Number(document.getElementById('duration').value);
}

function setOnlineStatus(text) {
  onlineStatus.textContent = text;
}

/**
 * Where to find the relay. By default it is the server that served this page,
 * which is what `npm start` gives you. On a static host (GitHub Pages and the
 * like) there is no relay, so `?relay=wss://your-relay.example` lets you point
 * at one running elsewhere without rebuilding anything.
 */
function relayUrl() {
  return relayFor(location);
}

const NO_RELAY_HINT = 'Could not reach a relay server. This page is hosted as static files, '
  + 'so online play needs a relay running somewhere: start one with "npm start" and add '
  + '?relay=wss://your-relay to this URL. One and two player modes work without it.';

function connect() {
  // An earlier attempt (say a room nobody ever joined) must not linger.
  if (game.signal) game.signal.close();
  const signal = new Signal(relayUrl());
  game.signal = signal;
  signal.on('error', (m) => setOnlineStatus(m.transport ? NO_RELAY_HINT : (m.msg || 'Connection error')));
  signal.on('close', () => {
    if (!game.state) setOnlineStatus(NO_RELAY_HINT);
  });
  return signal;
}

// Opening a match: we are the host, so we pick the seed.
document.getElementById('host').addEventListener('click', () => {
  goFullscreen();
  const secs = halfSeconds();
  const signal = connect();

  signal.on('room', (m) => {
    roomCode.textContent = m.code;
    roomCode.classList.remove('hidden');
    setOnlineStatus('Share this code and wait for your opponent...');
  });

  // The guest sends his line-up the moment he joins. We wait a moment for it,
  // then kick off regardless: a missing line-up should cost him his shape, not
  // the match. Whatever we end up with goes out in the start message, so both
  // machines build exactly the same two teams.
  let guestLineup = null;
  let peerArrived = false;
  let kickedOff = false;
  const beginHosted = () => {
    if (kickedOff) return;
    kickedOff = true;
    const seed = (Date.now() & 0x7fffffff) || 1;
    const formations = [lineups[0].spots, guestLineup || lineupFrom(DEFAULT_KEY)];
    // Goes over the wire so both sides start from identical settings.
    signal.send({
      t: 'start', seed, halfSeconds: secs, offside, formations,
    });
    startOnline({
      seed, halfSeconds: secs, localTeam: 0, signal, offside, formations,
    });
  };

  signal.on('lineup', (m) => {
    guestLineup = lineupFrom(m.spots);
    if (peerArrived) beginHosted();
  });

  signal.on('peer', () => {
    peerArrived = true;
    if (guestLineup) beginHosted();
    else setTimeout(beginHosted, 700);
  });

  document.getElementById('host').disabled = true;
  signal.create();
});

// Joining: we get the seed from the host and play red.
document.getElementById('join').addEventListener('click', () => {
  goFullscreen();
  const code = document.getElementById('joinCode').value.toUpperCase().trim();
  if (code.length < 4) {
    setOnlineStatus('Enter the four-character code.');
    return;
  }
  const signal = connect();

  signal.on('room', () => {
    setOnlineStatus('Connected. Waiting for kickoff...');
    // Ours to declare, before the host decides what the match looks like.
    signal.send({ t: 'lineup', spots: lineups[0].spots.map(({ x, y }) => ({ x, y })) });
  });
  signal.on('start', (m) => {
    startOnline({
      seed: m.seed,
      halfSeconds: m.halfSeconds,
      localTeam: 1,
      signal,
      offside: m.offside !== false,
      // The host's copy is the one that counts, even of our own line-up: two
      // machines disagreeing about where eleven players stand is a desync.
      formations: m.formations,
    });
  });

  setOnlineStatus('Connecting...');
  signal.join(code);
});

document.getElementById('joinCode').addEventListener('keydown', (e) => {
  if (e.code === 'Enter') document.getElementById('join').click();
  e.stopPropagation();
});

/**
 * Pausing, from a key or from a button.
 *
 * There was only the key, which on a phone means there was no way to stop and
 * no way out of a game except finishing it or reloading the page. The button in
 * the corner of the touch layer and the one in the panel are the same door.
 *
 * Never online: the other player is not waiting for you, and a lockstep
 * simulation that one side stopped stepping is a stalled game for both.
 */
function setPaused(on) {
  if (!game.state || game.transport.online) return;
  game.paused = on;
  pauseBox.classList.toggle('hidden', !game.paused);
  game.acc = 0;
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') setPaused(!game.paused);
});

document.getElementById('btnPause')?.addEventListener('click', () => setPaused(true));

// Browsers refuse to make a sound until the visitor has interacted with the
// page, so the tune waits for the first click or key press rather than being
// started on load and silently failing.
function startMusicOnFirstGesture() {
  if (soundOn) audio.wake();
  if (soundOn && !game.state) music.start();
  window.removeEventListener('pointerdown', startMusicOnFirstGesture);
  window.removeEventListener('keydown', startMusicOnFirstGesture);
}
window.addEventListener('pointerdown', startMusicOnFirstGesture);
window.addEventListener('keydown', startMusicOnFirstGesture);

// Handy when digging into network behaviour: from the console you can inspect
// __game.transport.ping / .delay / .stalls / .desync.
if (typeof window !== 'undefined') window.__game = game;
// For tuning the commentator: __say(['G', 'OW', 'L']) or __say('save').
window.__say = (what) => (Array.isArray(what) ? speech.speak(what) : speech.say(what));

requestAnimationFrame(frame);
