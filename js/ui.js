// ui.js — everything you see. It never touches game rules: it renders
// session.snapshot.view and turns clicks into session.act({...}) intents.
//
// CONCEPT — render from state. The board DOM is built ONCE (so tokens can glide
// with CSS transitions); each update just patches classes, positions and text.
// All text that came from other people (names) goes through esc() before it
// touches innerHTML — otherwise a friend named "<img onerror=…>" could run code.

import {
  SUSPECTS, WEAPONS, ROOMS, CELLAR, COLS, ROWS, GRID, VOID_RECTS, PASSAGES, DOORSTEP_TO_ROOM,
  SUSPECT_IDS, WEAPON_IDS, ROOM_IDS, suspectById, weaponById, roomById, cardName, cardType, isHall,
} from './data.js';
import {
  createHotseat, createHostSession, createClientSession, savedGame, forgetSavedGame,
} from './session.js';
import { normalizeCode } from './net.js';

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const ROOM_COLORS = {
  study: '#6b4a3a', hall: '#7a6a3f', lounge: '#80323a', library: '#4b5d38', dining: '#6c3a55',
  billiard: '#2d5c4b', conservatory: '#2f6b66', ballroom: '#4f4380', kitchen: '#80582a',
};
const DIE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

const ui = {
  kind: null,                // 'home' | 'hotseat' | 'lobby' | 'game' | 'msg'
  name: lsGet('cluedo.name') || '',
  joinCode: '',
  hot: SUSPECTS.map((s, i) => ({ on: i < 3, name: `Player ${i + 1}` })),
  tab: 'log',
  form: null,                // open suggest/accuse form
  unlocked: null,            // hotseat: which player's screen is currently revealed
  seenLog: {},               // `${gameId}:${you}` -> highest private log number already toasted
  notes: {},
  overShownFor: null,
  cache: {},
  diceKey: null,
};
let session = null;
let toastTimer = null;

// ===================================================================== helpers
const fg = id => (id === 'white' || id === 'mustard' ? '#1b1208' : '#fff');
const pawn = (id, big = false) => `<span class="pawn${big ? ' big' : ''}" style="background:${suspectById[id].color};color:${fg(id)}">${suspectById[id].short}</span>`;
const cardIcon = id => (cardType(id) === 'suspect' ? pawn(id) : cardType(id) === 'weapon' ? weaponById[id].icon : '🏛️');
const cardChip = id => `<span class="gc ${cardType(id)}">${cardIcon(id)}<span>${esc(cardName(id))}</span></span>`;

export function toast(text, ms = 4500) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openDlg(id) { const d = $('#' + id); if (!d.open) d.showModal(); return d; }
function closeDlg(id) { const d = $('#' + id); if (d.open) d.close(); }

// ===================================================================== entry
export function mount() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  $('#dlg-refute').addEventListener('cancel', e => e.preventDefault());   // must answer
  $('#dlg-form').addEventListener('close', () => { ui.form = null; });
  const q = new URLSearchParams(location.search);
  if (q.get('join')) ui.joinCode = normalizeCode(q.get('join'));
  render();
}

function setSession(s) {
  if (session) session.leave();
  session = s;
  ui.kind = null; ui.unlocked = null; ui.cache = {}; ui.diceKey = null;
  closeDlg('dlg-form'); closeDlg('dlg-refute'); closeDlg('dlg-over');
  $('#curtain').hidden = true;
  s.subscribe(() => render());
  render();
}

function leave() {
  if (session) session.leave();
  session = null; ui.kind = null; ui.screen = 'home';
  closeDlg('dlg-form'); closeDlg('dlg-refute'); closeDlg('dlg-over');
  $('#curtain').hidden = true;
  render();
}

// ===================================================================== router
function render() {
  if (!session) return ui.screen === 'hotseat' ? renderHotseatSetup() : renderHome();
  if (session.status === 'error') return renderMessage('Could not connect', session.error || 'Unknown error.');
  if (session.status === 'kicked') return renderMessage('Removed from the room', 'The host removed you from this game.');
  const snap = session.snapshot;
  if (!snap.lobby) return renderConnecting();
  if (!snap.view) { closeDlg('dlg-over'); closeDlg('dlg-refute'); ui.kind = 'lobby'; return renderLobby(); }
  if (ui.kind !== 'game') { buildGame(); ui.kind = 'game'; }
  updateGame();
  if (session.toast && session.toast.at > (ui.lastToast || 0)) { ui.lastToast = session.toast.at; toast(session.toast.text); }
}

// ===================================================================== home
function renderHome() {
  ui.kind = 'home';
  const save = savedGame();
  app.innerHTML = `
  <main class="screen">
    <div class="hero">
      <div class="eyebrow">A game of deduction</div>
      <h1>Cluedo</h1>
      <p>Who did it, with what, and where? Play with friends in the browser. No accounts, no servers to run.</p>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="field" style="margin:0"><label for="name">Your name</label>
        <input id="name" maxlength="20" placeholder="Detective name" value="${esc(ui.name)}" autocomplete="nickname"></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>Host an online game</h3>
        <p>Get a 5-letter room code and share it. Keep this tab open while you play.</p>
        <button class="btn primary" data-act="host">Create room</button></div>
      <div class="card"><h3>Join a game</h3>
        <p>Enter the code your host sent you.</p>
        <div class="field"><input id="code" class="code-input" maxlength="5" placeholder="ABCDE" value="${esc(ui.joinCode)}" autocapitalize="characters" autocomplete="off"></div>
        <button class="btn primary" data-act="join">Join room</button></div>
      <div class="card"><h3>Pass &amp; play</h3>
        <p>One device, everyone takes turns. The screen hides between players.</p>
        <button class="btn" data-act="hotseat">Set up players</button></div>
      <div class="card"><h3>Saved games</h3>
        <p>Hosts and pass-and-play games autosave in this browser.</p>
        <div class="row">
          ${save ? `<button class="btn primary" data-act="resume">Resume ${save.hotseat ? 'pass &amp; play' : 'hosted'} game</button>` : '<span class="muted">Nothing saved yet.</span>'}
          <label class="btn" style="cursor:pointer">Load file<input type="file" id="loadfile" accept="application/json,.json" hidden></label>
        </div></div>
    </div>
    <div class="footer-note"><button class="link" data-act="rules">How to play</button> · An unofficial fan project for private play with friends.</div>
  </main>`;
}

function renderHotseatSetup() {
  ui.kind = 'hotseat';
  const rows = SUSPECTS.map((s, i) => {
    const h = ui.hot[i];
    return `<div class="seat" style="opacity:${h.on ? 1 : .55}">
      <input type="checkbox" data-hot-on="${i}" ${h.on ? 'checked' : ''} aria-label="Play as ${esc(s.name)}">
      ${pawn(s.id, true)}
      <span style="width:140px;flex:none">${esc(s.name)}</span>
      <input data-hot-name="${i}" maxlength="20" value="${esc(h.name)}" style="flex:1;min-width:0" ${h.on ? '' : 'disabled'}>
    </div>`;
  }).join('');
  const count = ui.hot.filter(h => h.on).length;
  app.innerHTML = `
  <main class="screen" style="max-width:640px">
    <div class="hero"><div class="eyebrow">Pass &amp; play</div><h1 style="font-size:42px">Who is playing?</h1>
      <p>Tick 2 to 6 characters and type each player's name. Turn order follows the character order below.</p></div>
    <div class="card"><div class="seatlist">${rows}</div>
      <div class="row" style="justify-content:space-between"><button class="btn ghost" data-act="home">Back</button>
        <button class="btn primary" data-act="hotseat-start" ${count < 2 ? 'disabled' : ''}>Deal the cards</button></div></div>
  </main>`;
}

function renderConnecting() {
  ui.kind = 'msg';
  const host = session.mode === 'host';
  app.innerHTML = `<main class="screen center" style="padding-top:120px"><div class="spinner"></div>
    <h2>${host ? 'Opening your room…' : 'Connecting…'}</h2>
    <p class="muted">${host ? 'Registering the room code with the matchmaking broker.' : `Looking for room ${esc(session.roomCode)}.`}</p>
    <button class="btn ghost" data-act="leave">Cancel</button></main>`;
}

function renderMessage(title, text) {
  ui.kind = 'msg';
  app.innerHTML = `<main class="screen center" style="padding-top:120px"><h2>${esc(title)}</h2>
    <p class="err">${esc(text)}</p><button class="btn primary" data-act="leave">Back to menu</button></main>`;
}

// ===================================================================== lobby
function renderLobby() {
  const { lobby, you } = session.snapshot;
  const isHost = lobby.players.some(p => p.id === you && p.isHost);
  const taken = new Set(lobby.players.map(p => p.suspect));
  const seats = lobby.players.map(p => {
    const mine = p.id === you;
    const picker = mine ? `<div class="chips" style="margin-top:6px">${SUSPECTS.map(s => `
        <button class="chip ${s.id === p.suspect ? 'sel' : ''}" data-pick-suspect="${s.id}" ${taken.has(s.id) && s.id !== p.suspect ? 'disabled' : ''}>${pawn(s.id)}${esc(s.name)}</button>`).join('')}</div>` : '';
    return `<div class="seat ${mine ? 'me' : ''}" style="align-items:flex-start;flex-wrap:wrap">
      <span style="padding-top:2px">${pawn(p.suspect, true)}</span>
      <div style="flex:1;min-width:0"><div class="row" style="gap:8px"><span class="nm">${esc(p.name)}${mine ? ' (you)' : ''}</span>
        ${p.isHost ? '<span class="pill">host</span>' : ''}<span class="dot ${p.connected ? '' : 'off'}" title="${p.connected ? 'online' : 'offline'}"></span></div>
        <div class="muted" style="font-size:13px">${esc(suspectById[p.suspect].name)}</div>${picker}</div>
      ${isHost && !mine ? `<button class="btn small ghost" data-kick="${p.id}">Remove</button>` : ''}
    </div>`;
  }).join('');
  const link = `${location.origin}${location.pathname}?join=${lobby.roomCode}`;
  app.innerHTML = `
  <main class="screen" style="max-width:640px">
    <div class="hero" style="margin-bottom:10px"><div class="eyebrow">Room code</div>
      <div class="roomcode">${esc(lobby.roomCode)}</div>
      <div class="row" style="justify-content:center;margin-top:6px"><button class="btn small" data-act="copy-link" data-link="${esc(link)}">Copy invite link</button>
        <span class="muted" style="font-size:13px">or share the code</span></div></div>
    <div class="card"><h3>Players (${lobby.players.length}/6)</h3><div class="seatlist">${seats}</div>
      ${session.status === 'reconnecting' ? '<p class="err">Reconnecting to the host…</p>' : ''}
      <div class="row" style="justify-content:space-between">
        <button class="btn ghost" data-act="leave">Leave</button>
        ${isHost
          ? `<button class="btn primary" data-act="start" ${lobby.canStart ? '' : 'disabled'}>${lobby.canStart ? 'Deal the cards' : 'Need 2+ players'}</button>`
          : '<span class="muted">Waiting for the host to start…</span>'}
      </div></div>
    <div class="footer-note">Cards are dealt on the host's device and each player only ever receives their own hand.</div>
  </main>`;
}

// ===================================================================== game skeleton
const tileEls = [];
const roomEls = {};
const tokenEls = {};

function buildGame() {
  app.innerHTML = `
  <div class="topbar">
    <span class="brand">Cluedo</span>
    <span class="pill" id="roomPill"></span>
    <span class="sp"></span>
    <button class="btn small ghost" data-act="rules">Rules</button>
    <button class="btn small ghost" data-act="save">Save</button>
    <button class="btn small ghost" data-act="leave">Leave</button>
  </div>
  <div class="game">
    <div class="board-wrap"><div id="board" aria-label="Game board"></div></div>
    <aside class="side">
      <section class="panel" id="turnPanel">
        <div class="banner" id="banner"></div><div class="hint" id="hint"></div>
        <div class="dice" id="dice"><span class="die">⚀</span><span class="die">⚀</span><span class="total" id="total"></span></div>
        <div class="actions" id="actions"></div>
      </section>
      <section class="panel" id="handPanel"></section>
      <section class="panel" id="playersPanel"></section>
      <section class="panel">
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="log" aria-selected="true">Event log</button>
          <button class="tab" role="tab" data-tab="nb" aria-selected="false">Detective notebook</button>
        </div>
        <div id="logBox" class="log"></div>
        <div id="nbBox" hidden></div>
      </section>
    </aside>
  </div>`;
  buildBoard();
  ui.cache = {};
}

function absStyle(x, y, w = 1, h = 1) { return `--x:${x};--y:${y};--w:${w};--h:${h}`; }

function buildBoard() {
  const board = $('#board');
  const frag = document.createDocumentFragment();
  const mk = (cls, style, html = '') => { const d = document.createElement('div'); d.className = cls; d.setAttribute('style', style); d.innerHTML = html; return d; };

  for (const [x, y, w, h] of VOID_RECTS) frag.appendChild(mk('tile void abs', absStyle(x, y, w, h)));
  tileEls.length = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (!isHall(x, y)) continue;
    const t = mk(`tile abs${(x + y) % 2 ? ' alt' : ''}`, absStyle(x, y));
    t.dataset.x = x; t.dataset.y = y;
    const door = DOORSTEP_TO_ROOM[`${x},${y}`];
    if (door) {
      const dir = [['n', 0, -1], ['s', 0, 1], ['w', -1, 0], ['e', 1, 0]].find(([, dx, dy]) => GRID[y + dy] && GRID[y + dy][x + dx] === door);
      if (dir) t.dataset.door = dir[0];
    }
    tileEls[y * COLS + x] = t;
    frag.appendChild(t);
  }
  for (const r of ROOMS) {
    const [x, y, w, h] = r.rect;
    const pass = PASSAGES[r.id] ? `<small>secret passage ⇄ ${esc(roomById[PASSAGES[r.id]].name)}</small>` : '';
    const el = mk('room abs', absStyle(x, y, w, h) + `;background:${ROOM_COLORS[r.id]}`, `${esc(r.name)}${pass}`);
    el.dataset.room = r.id;
    roomEls[r.id] = el;
    frag.appendChild(el);
  }
  const [cx, cy, cw, ch] = CELLAR.rect;
  frag.appendChild(mk('cellar abs', absStyle(cx, cy, cw, ch), `<div>${esc(CELLAR.name)}<span>the solution is in here</span></div>`));

  const layer = mk('tokens', '');
  for (const s of SUSPECTS) {
    const t = mk('token s', absStyle(s.start[0], s.start[1]), `<i style="background:${s.color};color:${fg(s.id)}">${s.short}</i>`);
    t.title = s.name; tokenEls[s.id] = t; layer.appendChild(t);
  }
  for (const w of WEAPONS) {
    const t = mk('token w', absStyle(0, 0), `<i>${w.icon}</i>`);
    t.title = w.name; tokenEls[w.id] = t; layer.appendChild(t);
  }
  frag.appendChild(layer);
  board.replaceChildren(frag);
}

// ===================================================================== game update
function updateGame() {
  const snap = session.snapshot, view = snap.view, lobby = snap.lobby;
  const byId = Object.fromEntries(view.players.map(p => [p.id, p]));
  const online = Object.fromEntries(lobby.players.map(p => [p.id, p.connected]));

  // top bar
  const pill = $('#roomPill');
  pill.innerHTML = session.mode === 'hotseat' ? 'Pass &amp; play'
    : `Room <b>${esc(lobby.roomCode)}</b>${session.status === 'reconnecting' ? ' · reconnecting…' : ''}`;
  $('[data-act="save"]').hidden = session.mode === 'client';

  // hotseat curtain: hide secrets between players
  const curtain = $('#curtain');
  const needCurtain = session.mode === 'hotseat' && !view.over && ui.unlocked !== view.you;
  if (needCurtain) {
    const p = byId[view.you];
    curtain.innerHTML = `<div>${pawn(p.suspect, true)}<h2>Pass the device to ${esc(p.name)}</h2>
      <p>${view.phase === 'refute' ? `${esc(p.name)} must secretly choose a card to show.` : 'Everyone else look away, then tap below.'}</p>
      <button class="btn primary" data-act="unlock">I'm ${esc(p.name)}, show my screen</button></div>`;
    curtain.hidden = false;
    closeDlg('dlg-refute'); closeDlg('dlg-form');
  } else curtain.hidden = true;

  updateBoard(view, byId);
  updateTurnPanel(view, byId);
  updateHand(view);
  updatePlayers(view, online);
  updateLog(view);
  if (!$('#nbBox').hidden) updateNotebook(view);
  if (!needCurtain) { maybeToastPrivate(view); updateRefuteDialog(view, byId); }
  updateOverDialog(view, byId);
}

function updateBoard(view, byId) {
  const reachSig = JSON.stringify(view.moves);
  if (ui.cache.reach !== reachSig) {
    ui.cache.reach = reachSig;
    tileEls.forEach(t => t && t.classList.remove('reach'));
    Object.values(roomEls).forEach(r => r.classList.remove('reach'));
    if (view.moves) {
      for (const t of view.moves.tiles) { const el = tileEls[t.y * COLS + t.x]; if (el) { el.classList.add('reach'); el.title = `${t.d} step${t.d === 1 ? '' : 's'}`; } }
      for (const r of view.moves.rooms) { roomEls[r.room].classList.add('reach'); roomEls[r.room].title = `${r.d} step${r.d === 1 ? '' : 's'}`; }
    }
  }
  const perRoom = {};
  const place = (id, pos) => {
    const el = tokenEls[id];
    if (pos.room) { (perRoom[pos.room] ||= []).push(id); return; }
    el.style.setProperty('--x', pos.x); el.style.setProperty('--y', pos.y);
  };
  for (const id of SUSPECT_IDS) place(id, view.tokens.suspects[id]);
  for (const id of WEAPON_IDS) place(id, view.tokens.weapons[id]);
  for (const [room, ids] of Object.entries(perRoom)) {
    const [rx, ry, rw] = roomById[room].rect;
    ids.forEach((id, i) => {
      tokenEls[id].style.setProperty('--x', rx + (i % rw));
      tokenEls[id].style.setProperty('--y', ry + 1 + Math.floor(i / rw));
    });
  }
  const mine = byId[view.you];
  for (const p of view.players) {
    const el = tokenEls[p.suspect];
    el.classList.toggle('active', !view.over && p.id === view.turn);
    el.classList.toggle('mine', !!mine && p.id === view.you);
    el.classList.toggle('ghost', p.eliminated);
    el.title = `${suspectById[p.suspect].name} — ${p.name}`;
  }
  // light the room where the active player stands
  const turnPos = view.tokens.suspects[byId[view.turn].suspect];
  Object.entries(roomEls).forEach(([id, el]) => el.classList.toggle('here', turnPos.room === id));
}

function phaseText(view, byId) {
  const me = view.you, turnP = byId[view.turn], mineTurn = view.turn === me;
  const here = view.tokens.suspects[byId[me] ? byId[me].suspect : view.turn].room;
  if (view.over) {
    const w = byId[view.winner];
    return [`${esc(w.name)} wins!`, view.winnerByDefault ? 'Everyone else was eliminated.' : 'A perfect accusation.', true];
  }
  if (view.phase === 'refute') {
    if (view.can.refute) return ['Disprove the suggestion', 'Pick one matching card to show the suggester.', true];
    return [`${esc(byId[view.actor].name)} is choosing a card…`, 'Waiting for the card to be shown.', false];
  }
  if (!mineTurn) {
    const t = { start: 'to roll', move: 'to move', suggest: 'to make a suggestion', post: 'to finish their turn' }[view.phase];
    return [`${esc(turnP.name)}'s turn`, `Waiting for ${esc(turnP.name)} ${t}.`, false];
  }
  const name = session.mode === 'hotseat' ? `${esc(turnP.name)}, ` : '';
  if (view.phase === 'start') {
    let h = 'Roll the dice to move';
    if (view.can.passage) h += `, or take the secret passage to the ${roomById[PASSAGES[here]].name}`;
    if (view.can.stay) h = `Someone moved you here. Stay and make a suggestion, or roll to leave.`;
    return [`${name}your turn`, h + '.', true];
  }
  if (view.phase === 'move') {
    const none = !view.moves || (!view.moves.tiles.length && !view.moves.rooms.length);
    return [`${name}choose where to go`, none ? 'You are boxed in. End your turn (or accuse).' : `You rolled ${view.rolled}. Click a glowing square or room (up to ${view.rolled} steps).`, true];
  }
  if (view.phase === 'suggest') return [`${name}make a suggestion?`, `You are in the ${roomById[here].name}. Name a suspect and weapon, accuse, or end your turn.`, true];
  return [`${name}anything else?`, 'You may make your final accusation, or end your turn.', true];
}

function updateTurnPanel(view, byId) {
  const [banner, hint, you] = phaseText(view, byId);
  const b = $('#banner');
  b.innerHTML = banner; b.classList.toggle('you', you);
  $('#hint').textContent = hint.replace(/&#39;/g, "'");
  // dice (persistent elements so the tumble animation survives re-renders)
  const dice = $('#dice'), faces = dice.querySelectorAll('.die');
  const key = view.dice ? `${view.turnNo}:${view.dice.join('-')}` : null;
  if (key !== ui.diceKey) {
    ui.diceKey = key;
    if (!key) { faces.forEach(f => { f.textContent = '⚀'; f.style.opacity = .25; }); $('#total').textContent = ''; }
    else {
      faces.forEach((f, i) => {
        f.style.opacity = 1; f.classList.remove('roll'); void f.offsetWidth; f.classList.add('roll');
        let n = 0;
        const spin = setInterval(() => { f.textContent = DIE[Math.floor(Math.random() * 6)]; if (++n > 7) { clearInterval(spin); f.textContent = DIE[view.dice[i] - 1]; } }, 55);
      });
      $('#total').textContent = `= ${view.rolled}`;
    }
  }
  // actions
  const c = view.can, here = view.tokens.suspects[(byId[view.you] || {}).suspect];
  const btn = (act, label, enabled, cls = '', extra = '') => `<button class="btn ${cls}" data-act="${act}" ${enabled ? '' : 'disabled'} ${extra}>${label}</button>`;
  let html = '';
  html += btn('roll', 'Roll dice', c.roll, 'primary wide');
  if (c.passage && here && here.room) html += btn('passage', `Secret passage → ${esc(roomById[PASSAGES[here.room]].name)}`, true, 'wide');
  if (c.stay) html += btn('stay', 'Stay &amp; suggest', true, 'wide');
  html += btn('suggest-open', 'Suggest', c.suggest, 'primary') + btn('accuse-open', 'Accuse…', c.accuse, 'danger');
  html += btn('end', 'End turn', c.endTurn, 'wide');
  if (view.over) html = `<button class="btn primary wide" data-act="show-over">Show results</button>`;
  const sig = html;
  if (ui.cache.actions !== sig) { ui.cache.actions = sig; $('#actions').innerHTML = html; }
}

function updateHand(view) {
  const sig = JSON.stringify([view.hand, view.faceUp, view.you]);
  if (ui.cache.hand === sig) return;
  ui.cache.hand = sig;
  const groups = t => view.hand.filter(c => cardType(c) === t);
  $('#handPanel').innerHTML = `<h3>Your cards</h3>
    <div class="cards">${view.hand.length ? view.hand.map(cardChip).join('') : '<span class="muted">Spectating</span>'}</div>
    ${view.faceUp.length ? `<div class="sub">Face-up cards (everyone sees these, so they are not in the envelope)</div><div class="cards">${view.faceUp.map(cardChip).join('')}</div>` : ''}`;
  void groups;
}

function updatePlayers(view, online) {
  const sig = JSON.stringify([view.players, view.turn, view.over, online, view.phase, view.actor]);
  if (ui.cache.players === sig) return;
  ui.cache.players = sig;
  $('#playersPanel').innerHTML = `<h3>Detectives</h3><div class="plist">${view.players.map(p => `
    <div class="pl ${p.id === view.turn && !view.over ? 'turn' : ''} ${p.eliminated ? 'out' : ''}">
      ${pawn(p.suspect)}<span class="nm">${esc(p.name)}${p.id === view.you && session.mode !== 'hotseat' ? ' (you)' : ''}</span>
      <span class="meta">${p.eliminated ? 'eliminated · ' : ''}${p.handCount} cards${online[p.id] === false ? ' · offline' : ''}</span></div>`).join('')}</div>`;
}

function updateLog(view) {
  const box = $('#logBox');
  const sig = `${view.log.length}:${view.log.length ? view.log[view.log.length - 1].n : 0}:${view.you}`;
  if (ui.cache.log === sig) return;
  ui.cache.log = sig;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = view.log.map(l => `<div class="${l.to ? 'priv' : /^.*'s turn\.$|ends their turn/.test(l.text) ? 'sys' : ''}">${esc(l.text)}</div>`).join('');
  if (atBottom || !ui.cache.logSeen) box.scrollTop = box.scrollHeight;
  ui.cache.logSeen = true;
}

function maybeToastPrivate(view) {
  const key = `${view.gameId}:${view.you}`;
  const mine = view.log.filter(l => l.to);
  const top = mine.length ? mine[mine.length - 1].n : 0;
  if (ui.seenLog[key] === undefined) { ui.seenLog[key] = top; return; }
  if (top > ui.seenLog[key]) {
    ui.seenLog[key] = top;
    toast(mine[mine.length - 1].text, 9000);
  }
}

// ===================================================================== notebook
const NB_CYCLE = ['', 'x', 'y', 'q'];
const NB_LABEL = { '': '', x: '✗', y: '✓', q: '?' };

function notesFor(view) {
  const key = `cluedo.notes.${view.gameId}.${view.you}`;
  if (!ui.notes[key]) { try { ui.notes[key] = JSON.parse(lsGet(key) || '{}'); } catch { ui.notes[key] = {}; } }
  return [key, ui.notes[key]];
}

function autoMarks(view) {
  const cols = [...view.players.map(p => p.id), 'env'];
  const m = {};
  const only = (card, holder) => cols.forEach(c => { m[`${card}|${c}`] = c === holder ? 'y' : 'x'; });
  for (const c of view.hand) only(c, view.you);
  for (const s of view.shown) only(s.card, s.by);
  for (const c of view.faceUp) cols.forEach(col => { m[`${c}|${col}`] = 'x'; });
  return m;
}

function updateNotebook(view) {
  const [, notes] = notesFor(view);
  const auto = autoMarks(view);
  const sig = JSON.stringify([notes, auto, view.players.map(p => p.id), view.hand]);
  if (ui.cache.nb === sig) return;
  ui.cache.nb = sig;
  const cols = [...view.players.map(p => p.id), 'env'];
  const head = `<tr><th></th>${view.players.map(p => `<th title="${esc(p.name)}">${pawn(p.suspect)}</th>`).join('')}<th class="env" title="The envelope">Env</th></tr>`;
  const section = (title, ids) => `<tr class="sect"><td colspan="${cols.length + 1}">${title}</td></tr>` + ids.map(id => `
    <tr class="${view.hand.includes(id) ? 'mine' : ''}"><td>${cardName(id)}</td>${cols.map(c => {
      const k = `${id}|${c}`;
      const user = notes[k];
      const eff = user !== undefined ? (user === 'n' ? '' : user) : (auto[k] || '');
      const isAuto = user === undefined && !!auto[k];
      return `<td class="${c === 'env' ? 'env' : ''}"><button data-nb="${k}" data-v="${eff}" class="${isAuto ? 'auto' : ''}" aria-label="${esc(cardName(id))}">${NB_LABEL[eff]}</button></td>`;
    }).join('')}</tr>`).join('');
  $('#nbBox').innerHTML = `<table class="nb">${head}${section('Suspects', SUSPECT_IDS)}${section('Weapons', WEAPON_IDS)}${section('Rooms', ROOM_IDS)}</table>
    <div class="row" style="justify-content:space-between;margin-top:10px"><span class="muted" style="font-size:12px">Tap to cycle ✗ ✓ ?. Dashed marks are filled in for you.</span>
    <button class="btn small ghost" data-act="nb-clear">Clear</button></div>`;
}

// ===================================================================== dialogs
function chipRow(kind, ids, selected) {
  return `<div class="chips">${ids.map(id => `<button class="chip ${selected === id ? 'sel' : ''}" data-form="${kind}:${id}">${cardIcon(id)}${esc(cardName(id))}</button>`).join('')}</div>`;
}

function renderForm() {
  const f = ui.form; if (!f) return;
  const view = session.snapshot.view;
  const suggest = f.kind === 'suggest';
  const ready = f.suspect && f.weapon && (suggest || f.room);
  const dlg = $('#dlg-form');
  dlg.innerHTML = `
    <h2>${suggest ? 'Make a suggestion' : 'Final accusation'}</h2>
    <p class="muted" style="margin:0">${suggest
      ? `In the <b>${esc(roomById[f.room].name)}</b>. The suspect and weapon you name will be moved into the room, and the others will try to disprove you.`
      : 'Get it wrong and you are out of the game (you will still have to show cards). You can accuse from anywhere.'}</p>
    <div class="sub">Suspect</div>${chipRow('suspect', SUSPECT_IDS, f.suspect)}
    <div class="sub">Weapon</div>${chipRow('weapon', WEAPON_IDS, f.weapon)}
    ${suggest ? '' : `<div class="sub">Room</div>${chipRow('room', ROOM_IDS, f.room)}`}
    <div class="foot"><button class="btn ghost" data-act="form-cancel">Cancel</button>
      <button class="btn ${suggest ? 'primary' : 'danger'}" data-act="form-go" ${ready ? '' : 'disabled'}>${suggest ? 'Suggest' : 'Accuse!'}</button></div>`;
  void view;
}

function openForm(kind) {
  const view = session.snapshot.view;
  const me = view.players.find(p => p.id === view.you);
  const pos = view.tokens.suspects[me.suspect];
  ui.form = { kind, suspect: null, weapon: null, room: kind === 'suggest' ? pos.room : null };
  renderForm();
  openDlg('dlg-form');
}

function updateRefuteDialog(view, byId) {
  if (!(view.can.refute && view.pending && view.pending.options)) { closeDlg('dlg-refute'); ui.cache.refute = null; return; }
  const p = view.pending;
  const key = `${view.turnNo}:${p.options.join()}`;
  if (ui.cache.refute === key && $('#dlg-refute').open) return;
  ui.cache.refute = key;
  $('#dlg-refute').innerHTML = `
    <h2>Disprove the suggestion</h2>
    <p class="muted" style="margin:0"><b>${esc(byId[p.suggester].name)}</b> suggests it was <b>${esc(cardName(p.suspect))}</b>, with the <b>${esc(cardName(p.weapon))}</b>, in the <b>${esc(cardName(p.room))}</b>.
      You hold more than one of those cards. Choose which one to show. Only ${esc(byId[p.suggester].name)} will see it.</p>
    <div class="sub">Show one</div>
    <div class="chips">${p.options.map(c => `<button class="chip big-card" data-refute="${c}">${cardIcon(c)}${esc(cardName(c))}</button>`).join('')}</div>`;
  openDlg('dlg-refute');
}

function updateOverDialog(view, byId) {
  if (!view.over) { ui.overShownFor = null; closeDlg('dlg-over'); return; }
  if (ui.overShownFor === view.gameId) return;
  ui.overShownFor = view.gameId;
  showOver(view, byId);
}

function showOver(view = session.snapshot.view, byId = Object.fromEntries(view.players.map(p => [p.id, p]))) {
  const w = byId[view.winner], sol = view.solution;
  const isHost = session.snapshot.lobby.players.some(p => p.id === view.you && p.isHost);
  $('#dlg-over').innerHTML = `
    <div class="center"><div class="eyebrow">Case closed</div><h2>${esc(w.name)} ${view.winnerByDefault ? 'wins by default' : 'solved it!'}</h2>
    <p class="muted">${view.winnerByDefault ? 'Every other detective made a wrong accusation. ' : ''}The envelope held:</p>
    <div class="cards" style="justify-content:center;margin:12px 0">${[sol.suspect, sol.weapon, sol.room].map(c => `<span class="gc ${cardType(c)} big-card">${cardIcon(c)}${esc(cardName(c))}</span>`).join('')}</div></div>
    <div class="foot" style="justify-content:center"><button class="btn ghost" data-act="close-over">Look at the board</button>
      ${isHost ? '<button class="btn primary" data-act="rematch">Play again</button>' : '<span class="muted">The host can start a rematch.</span>'}
      <button class="btn ghost" data-act="leave">Leave</button></div>`;
  openDlg('dlg-over');
}

const RULES = `
<h2>How to play</h2>
<div class="rules">
<p>Someone was murdered in the mansion. One suspect, one weapon and one room are sealed in the envelope. Everyone else holds the other cards. Work out the three secret cards by elimination, then make a correct <b>final accusation</b>.</p>
<h3>On your turn</h3>
<ul><li><b>Roll</b> two dice and move up to that many squares. You cannot pass through another detective's piece. Entering a room ends your move.</li>
<li>In a corner room you may use the <b>secret passage</b> instead of rolling (Study ⇄ Kitchen, Lounge ⇄ Conservatory).</li>
<li>If another player's suggestion moved you into a room, you may <b>stay</b> there and suggest without rolling.</li></ul>
<h3>Suggesting</h3>
<ul><li>When you are in a room, name a suspect and a weapon. That suspect and weapon are moved into the room.</li>
<li>Going clockwise, the first player holding any of the three cards (suspect, weapon, this room) must secretly show you one. Everyone sees <i>that</i> a card was shown, but only you see <i>which</i>.</li></ul>
<h3>Accusing</h3>
<ul><li>On your turn, from anywhere, you may accuse. Right: you win. Wrong: you are eliminated but still show cards to others.</li></ul>
<h3>House rules in this version</h3>
<ul><li>With 4 or 5 players the cards that cannot be dealt evenly are placed face-up for everyone.</li>
<li>Movement is "up to" the roll. Eliminated detectives do not block squares.</li>
<li>If a player has exactly one matching card, it is shown automatically.</li></ul>
<h3>Tips</h3>
<ul><li>Use the <b>Detective notebook</b> tab. Your own cards are marked for you.</li>
<li>Suggest about cards you hold yourself to bluff or to test one card at a time.</li></ul>
</div>
<div class="foot"><button class="btn primary" data-act="close-rules">Got it</button></div>`;

// ===================================================================== events
function onInput(e) {
  const t = e.target;
  if (t.id === 'name') { ui.name = t.value; lsSet('cluedo.name', ui.name); }
  else if (t.id === 'code') { t.value = ui.joinCode = normalizeCode(t.value); }
  else if (t.dataset.hotName !== undefined) ui.hot[+t.dataset.hotName].name = t.value;
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.hotOn !== undefined) { ui.hot[+t.dataset.hotOn].on = t.checked; renderHotseatSetup(); }
  else if (t.id === 'loadfile' && t.files[0]) {
    t.files[0].text().then(txt => {
      try { resumeFrom(JSON.parse(txt)); } catch { toast('That file is not a saved game.'); }
    });
  }
}

function resumeFrom(save) {
  if (!save || !save.players || save.v !== 1) throw new Error('bad save');
  if (save.hotseat) return setSession(createHotseat(null, save));
  setSession(createHostSession(ui.name || 'Host', save));
}

function onClick(e) {
  const t = e.target.closest('[data-act],[data-pick-suspect],[data-kick],[data-form],[data-refute],[data-nb],[data-tab]');
  if (!t) {
    const tile = e.target.closest('#board .tile.reach, #board .room.reach');
    if (tile && session) {
      session.act({ type: 'move', to: tile.dataset.room ? { room: tile.dataset.room } : { x: +tile.dataset.x, y: +tile.dataset.y } });
    }
    return;
  }
  const d = t.dataset;
  if (d.pickSuspect) return session.pick(d.pickSuspect);
  if (d.kick) return session.kick(d.kick);
  if (d.refute) { closeDlg('dlg-refute'); return session.act({ type: 'refute', card: d.refute }); }
  if (d.tab) {
    $('#logBox').hidden = d.tab !== 'log'; $('#nbBox').hidden = d.tab !== 'nb';
    document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === d.tab)));
    if (d.tab === 'nb') { ui.cache.nb = null; updateNotebook(session.snapshot.view); }
    return;
  }
  if (d.nb) {
    const view = session.snapshot.view, [key, notes] = notesFor(view);
    const auto = autoMarks(view);
    const user = notes[d.nb];
    const cur = user !== undefined ? (user === 'n' ? '' : user) : (auto[d.nb] || '');
    const next = NB_CYCLE[(NB_CYCLE.indexOf(cur) + 1) % NB_CYCLE.length];
    notes[d.nb] = next === '' ? 'n' : next;
    lsSet(key, JSON.stringify(notes));
    ui.cache.nb = null; return updateNotebook(view);
  }
  if (d.form) {
    const [kind, id] = d.form.split(':');
    ui.form[kind] = id; return renderForm();
  }

  switch (d.act) {
    case 'home': ui.screen = 'home'; return render();
    case 'rules': $('#dlg-rules').innerHTML = RULES; return openDlg('dlg-rules');
    case 'close-rules': return closeDlg('dlg-rules');
    case 'host': {
      if (!ui.name.trim()) return toast('Type your name first.');
      return setSession(createHostSession(ui.name.trim()));
    }
    case 'join': {
      if (!ui.name.trim()) return toast('Type your name first.');
      if (ui.joinCode.length !== 5) return toast('Room codes have 5 letters.');
      return setSession(createClientSession(ui.joinCode, ui.name.trim()));
    }
    case 'hotseat': ui.screen = 'hotseat'; return render();
    case 'hotseat-start': {
      const seats = SUSPECTS.map((s, i) => ({ suspect: s.id, name: (ui.hot[i].name || s.name).trim() || s.name, on: ui.hot[i].on })).filter(s => s.on);
      return setSession(createHotseat(seats));
    }
    case 'resume': { const s = savedGame(); if (s) { try { return resumeFrom(s); } catch { forgetSavedGame(); toast('Saved game was unreadable.'); render(); } } return; }
    case 'leave': {
      if (session && session.snapshot.view && !session.snapshot.view.over && !confirm('Leave this game? Hosts keep an autosave to resume later.')) return;
      return leave();
    }
    case 'copy-link': {
      const link = d.link;
      return (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied.'), () => prompt('Copy this link:', link));
    }
    case 'start': return session.start();
    case 'save': {
      const json = session.exportSave();
      if (json) download(`cluedo-${session.roomCode}.json`, JSON.stringify(json));
      return;
    }
    case 'unlock': ui.unlocked = session.snapshot.view.you; ui.cache = {}; return render();
    case 'roll': return session.act({ type: 'roll' });
    case 'passage': return session.act({ type: 'passage' });
    case 'stay': return session.act({ type: 'stay' });
    case 'end': return session.act({ type: 'endTurn' });
    case 'suggest-open': return openForm('suggest');
    case 'accuse-open': return openForm('accuse');
    case 'form-cancel': return closeDlg('dlg-form');
    case 'form-go': {
      const f = ui.form; closeDlg('dlg-form');
      return session.act(f.kind === 'suggest' ? { type: 'suggest', suspect: f.suspect, weapon: f.weapon } : { type: 'accuse', suspect: f.suspect, weapon: f.weapon, room: f.room });
    }
    case 'nb-clear': {
      const view = session.snapshot.view, [key] = notesFor(view);
      ui.notes[key] = {}; lsSet(key, '{}'); ui.cache.nb = null; return updateNotebook(view);
    }
    case 'show-over': return showOver();
    case 'close-over': return closeDlg('dlg-over');
    case 'rematch': closeDlg('dlg-over'); ui.kind = null; return session.rematch();
    default:
  }
}
