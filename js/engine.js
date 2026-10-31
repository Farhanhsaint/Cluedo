// engine.js — the rules of Cluedo as PURE functions.
//
//   applyAction(state, playerId, action)  ->  { ok:true, state } | { ok:false, error }
//
// "Pure" means: no DOM, no network, no Date, no Math.random. The same state plus
// the same action always gives the same result. That is what lets us run this
// exact file in the host's browser, in Node tests, or on a server later.
//
// CONCEPT — the turn is a STATE MACHINE. `state.phase` says what is allowed next:
//
//   start ──roll──────────► move ──move to room──► suggest ──suggest──► (refute) ──► post
//     │  ──passage / stay──────────────────────────► suggest             │
//     │                       move ──move to hall──► post ◄───────────────┘
//     └── accuse (any phase except refute) ──► over  (or the accuser is eliminated)
//   any of start/move/suggest/post ──endTurn──► next player's `start`
//
// Anything that is not legal in the current phase is rejected, which is the
// single most important defence against bugs (and against cheating).

import {
  SUSPECTS, SUSPECT_IDS, WEAPON_IDS, ROOM_IDS, ALL_CARDS,
  DOORS, PASSAGES, DOORSTEP_TO_ROOM, isHall, cardName, suspectById, roomById, weaponById,
} from './data.js';

// ---------------------------------------------------------------------------
// Seeded random numbers. The generator's whole memory is ONE integer
// (state.rng), so the game state stays a plain JSON object and a game can be
// replayed from its seed. Algorithm: mulberry32.
// ---------------------------------------------------------------------------
function rand(s) {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (s, n) => Math.floor(rand(s) * n);

// Fisher–Yates: walk from the end, swap each slot with a random earlier-or-same slot.
// Every permutation is equally likely, and it is O(n) time, in place.
function shuffle(s, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(s, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function createGame({ players, seed = Date.now(), id = 'g1' }) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error('Cluedo needs 2 to 6 players.');
  }
  const ids = new Set(players.map(p => p.id));
  const suspects = new Set(players.map(p => p.suspect));
  if (ids.size !== players.length) throw new Error('Duplicate player id.');
  if (suspects.size !== players.length) throw new Error('Two players picked the same character.');
  if (![...suspects].every(x => SUSPECT_IDS.includes(x))) throw new Error('Unknown character.');

  const s = { seed: seed >>> 0, rng: seed >>> 0 };

  // 1) Secret envelope FIRST: one suspect, one weapon, one room.
  const solution = {
    suspect: SUSPECT_IDS[randInt(s, SUSPECT_IDS.length)],
    weapon: WEAPON_IDS[randInt(s, WEAPON_IDS.length)],
    room: ROOM_IDS[randInt(s, ROOM_IDS.length)],
  };

  // 2) Shuffle the remaining 18 cards and deal round-robin. If 18 doesn't split
  //    evenly (4 or 5 players) the leftovers go face-up for everyone to see.
  const deck = shuffle(s, ALL_CARDS.filter(c => c !== solution.suspect && c !== solution.weapon && c !== solution.room));
  // Turn order follows the box: Scarlett, Mustard, White, Green, Peacock, Plum.
  const seated = [...players].sort((a, b) => SUSPECT_IDS.indexOf(a.suspect) - SUSPECT_IDS.indexOf(b.suspect));
  const n = seated.length;
  const each = Math.floor(deck.length / n);
  const hands = seated.map(() => []);
  for (let i = 0; i < each * n; i++) hands[i % n].push(deck[i]);
  const faceUp = deck.slice(each * n);

  // 3) Tokens. Weapons start in 6 different random rooms.
  const suspectPos = {};
  for (const sp of SUSPECTS) suspectPos[sp.id] = { x: sp.start[0], y: sp.start[1] };
  const roomsShuffled = shuffle(s, [...ROOM_IDS]);
  const weaponPos = {};
  WEAPON_IDS.forEach((w, i) => { weaponPos[w] = { room: roomsShuffled[i] }; });

  const state = {
    id,                    // public label for this game (never derive it from the seed!)
    seed: s.seed, rng: s.rng,
    players: seated.map((p, i) => ({
      id: p.id, name: String(p.name || p.id).slice(0, 24), suspect: p.suspect,
      hand: hands[i].sort(sortCards), eliminated: false,
    })),
    solution,
    faceUp: faceUp.sort(sortCards),
    tokens: { suspects: suspectPos, weapons: weaponPos },
    turn: 0, turnNo: 1, phase: 'start',
    dice: null, rolled: 0,
    movedBy: {},          // playerId -> true if another player's suggestion moved them into a room
    pending: null,        // set while a refuting player must choose which card to show
    shown: [],            // PRIVATE: {to, by, card} — what each suggester has been shown
    log: [], logN: 0,
    over: false, winner: null, winnerByDefault: false,
  };
  addLog(state, `The game begins. ${state.players[0].name} goes first.`);
  return state;
}

const sortCards = (a, b) => ALL_CARDS.indexOf(a) - ALL_CARDS.indexOf(b);

function addLog(s, text, to = null) {
  s.log.push({ n: ++s.logN, text, to });
  if (s.log.length > 400) s.log.shift();
}

// ---------------------------------------------------------------------------
// Movement = breadth-first search (BFS) over the board graph.
//
// BFS explores nodes in rings: everything 1 step away, then 2 steps, and so on.
// So the first time we reach a node we have found its SHORTEST distance, and
// the `prev` map lets us rebuild the path. The board has ~500 nodes, so this is
// effectively instant.
// ---------------------------------------------------------------------------
const tk = (x, y) => `t:${x},${y}`;
const rk = room => `r:${room}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Tiles occupied by pieces that block movement (not eliminated players, not the mover). */
export function blockedTiles(s, exceptSuspect) {
  const eliminatedSuspects = new Set(s.players.filter(p => p.eliminated).map(p => p.suspect));
  const blocked = new Set();
  for (const [id, pos] of Object.entries(s.tokens.suspects)) {
    if (id === exceptSuspect || eliminatedSuspects.has(id) || pos.room) continue;
    blocked.add(`${pos.x},${pos.y}`);
  }
  return blocked;
}

export function reachable(s, suspectId, steps) {
  const start = s.tokens.suspects[suspectId];
  const blocked = blockedTiles(s, suspectId);
  const startKey = start.room ? rk(start.room) : tk(start.x, start.y);
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const queue = [startKey];

  const visit = (from, key) => {
    if (dist.has(key)) return;
    dist.set(key, dist.get(from) + 1);
    prev.set(key, from);
    queue.push(key);
  };

  for (let head = 0; head < queue.length; head++) {
    const key = queue[head];
    const d = dist.get(key);
    if (d >= steps) continue;
    if (key.startsWith('r:')) {
      // Leaving a room: step onto any free doorstep tile of that room.
      if (key !== startKey) continue; // entering a room ends the move
      for (const [x, y] of DOORS[key.slice(2)]) if (!blocked.has(`${x},${y}`)) visit(key, tk(x, y));
    } else {
      const [x, y] = key.slice(2).split(',').map(Number);
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (isHall(nx, ny) && !blocked.has(`${nx},${ny}`)) visit(key, tk(nx, ny));
      }
      const doorRoom = DOORSTEP_TO_ROOM[`${x},${y}`];
      // You may not "move" into the room you are already standing in.
      if (doorRoom && !(startKey === rk(doorRoom))) visit(key, rk(doorRoom));
    }
  }

  const tiles = [], rooms = [];
  for (const [key, d] of dist) {
    if (key === startKey) continue;
    if (key.startsWith('r:')) rooms.push({ room: key.slice(2), d });
    else { const [x, y] = key.slice(2).split(',').map(Number); tiles.push({ x, y, d }); }
  }
  return { tiles, rooms, prev, startKey };
}

/** Rebuild the route to `to` ({x,y} or {room}) as a list of tile/room positions. */
export function pathTo(r, to) {
  let key = to.room ? rk(to.room) : tk(to.x, to.y);
  const out = [];
  while (key && key !== r.startKey) {
    out.push(key.startsWith('r:') ? { room: key.slice(2) } : { x: +key.slice(2).split(',')[0], y: +key.slice(2).split(',')[1] });
    key = r.prev.get(key);
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const current = s => s.players[s.turn];
const playerBySuspect = (s, sid) => s.players.find(p => p.suspect === sid);
const activePlayers = s => s.players.filter(p => !p.eliminated);

function advanceTurn(s) {
  const prev = current(s);
  delete s.movedBy[prev.id];
  const n = s.players.length;
  do { s.turn = (s.turn + 1) % n; } while (s.players[s.turn].eliminated);
  s.turnNo++;
  s.phase = 'start';
  s.dice = null;
  s.rolled = 0;
  s.pending = null;
  addLog(s, `${current(s).name}'s turn.`);
}

function showCard(s, refuter, suggester, card) {
  s.shown.push({ to: suggester.id, by: refuter.id, card });
  addLog(s, `${refuter.name} showed a card to ${suggester.name}.`);
  addLog(s, `${refuter.name} showed you: ${cardName(card)}.`, suggester.id);
}

const err = error => ({ ok: false, error });

// ---------------------------------------------------------------------------
// The one entry point: validate an intent, then apply it to a COPY of the state.
// ---------------------------------------------------------------------------
export function applyAction(prev, playerId, action) {
  if (!action || typeof action.type !== 'string') return err('Bad action.');
  if (prev.over) return err('The game is over.');
  const s = structuredClone(prev);
  const me = s.players.find(p => p.id === playerId);
  if (!me) return err('You are not in this game.');

  // The only action allowed out of turn: the refuter choosing which card to show.
  if (action.type === 'refute') {
    if (s.phase !== 'refute' || !s.pending || s.pending.refuter !== playerId) return err('You are not being asked to show a card.');
    if (!s.pending.options.includes(action.card)) return err('Pick one of the cards that matches the suggestion.');
    const suggester = s.players.find(p => p.id === s.pending.suggester);
    showCard(s, me, suggester, action.card);
    s.pending = null;
    s.phase = 'post';
    return { ok: true, state: s };
  }

  const isTurn = current(s).id === playerId;
  if (!isTurn) return err("It isn't your turn.");
  if (s.phase === 'refute') return err('Waiting for a card to be shown.');
  const pos = s.tokens.suspects[me.suspect];

  switch (action.type) {
    case 'roll': {
      if (s.phase !== 'start') return err('You can only roll at the start of your turn.');
      const d1 = 1 + randInt(s, 6), d2 = 1 + randInt(s, 6);
      s.dice = [d1, d2];
      s.rolled = d1 + d2;
      delete s.movedBy[me.id];
      s.phase = 'move';
      addLog(s, `${me.name} rolled ${d1} + ${d2} = ${s.rolled}.`);
      const r = reachable(s, me.suspect, s.rolled);
      if (!r.tiles.length && !r.rooms.length) addLog(s, `${me.name} is boxed in and cannot move.`);
      return { ok: true, state: s };
    }

    case 'passage': {
      if (s.phase !== 'start') return err('Use a secret passage instead of rolling, at the start of your turn.');
      if (!pos.room || !PASSAGES[pos.room]) return err('There is no secret passage here.');
      const dest = PASSAGES[pos.room];
      s.tokens.suspects[me.suspect] = { room: dest };
      delete s.movedBy[me.id];
      s.phase = 'suggest';
      addLog(s, `${me.name} slipped through the secret passage to the ${roomById[dest].name}.`);
      return { ok: true, state: s };
    }

    case 'stay': {
      if (s.phase !== 'start' || !pos.room || !s.movedBy[me.id]) return err("You can only stay if someone's suggestion moved you into this room.");
      delete s.movedBy[me.id];
      s.phase = 'suggest';
      addLog(s, `${me.name} stays in the ${roomById[pos.room].name}.`);
      return { ok: true, state: s };
    }

    case 'move': {
      if (s.phase !== 'move') return err('Roll the dice first.');
      const to = action.to || {};
      const r = reachable(s, me.suspect, s.rolled);
      if (to.room) {
        const hit = r.rooms.find(x => x.room === to.room);
        if (!hit) return err("You can't reach that room with this roll.");
        s.tokens.suspects[me.suspect] = { room: to.room };
        s.phase = 'suggest';
        addLog(s, `${me.name} entered the ${roomById[to.room].name}.`);
      } else {
        const hit = r.tiles.find(t => t.x === to.x && t.y === to.y);
        if (!hit) return err("You can't reach that square with this roll.");
        s.tokens.suspects[me.suspect] = { x: to.x, y: to.y };
        s.phase = 'post';
        addLog(s, `${me.name} moved ${hit.d} space${hit.d === 1 ? '' : 's'}.`);
      }
      return { ok: true, state: s };
    }

    case 'suggest': {
      if (s.phase !== 'suggest') return err('You can only suggest right after entering a room.');
      if (!pos.room) return err('You must be in a room to make a suggestion.');
      const { suspect, weapon } = action;
      if (!suspectById[suspect] || !weaponById[weapon]) return err('Pick a suspect and a weapon.');
      const room = pos.room;

      // The accused suspect and the weapon are summoned into the room.
      s.tokens.suspects[suspect] = { room };
      s.tokens.weapons[weapon] = { room };
      const summoned = playerBySuspect(s, suspect);
      if (summoned && summoned.id !== me.id) s.movedBy[summoned.id] = true;
      addLog(s, `${me.name} suggests: ${cardName(suspect)}, with the ${cardName(weapon)}, in the ${roomById[room].name}.`);

      // Refutation: go clockwise; the first player holding a matching card must show ONE.
      const triple = [suspect, weapon, room];
      const n = s.players.length;
      let resolved = false;
      for (let j = 1; j < n && !resolved; j++) {
        const p = s.players[(s.turn + j) % n];
        const matches = p.hand.filter(c => triple.includes(c));
        if (matches.length === 1) {
          showCard(s, p, me, matches[0]);        // forced, so no choice to wait for
          resolved = true;
        } else if (matches.length > 1) {
          s.pending = { suggester: me.id, refuter: p.id, suspect, weapon, room, options: matches };
          s.phase = 'refute';
          addLog(s, `${p.name} can disprove it and is choosing a card…`);
          return { ok: true, state: s };
        }
      }
      if (!resolved) addLog(s, 'Nobody could disprove the suggestion.');
      s.phase = 'post';
      return { ok: true, state: s };
    }

    case 'accuse': {
      const { suspect, weapon, room } = action;
      if (!suspectById[suspect] || !weaponById[weapon] || !roomById[room]) return err('Pick a suspect, a weapon and a room.');
      addLog(s, `${me.name} makes a FINAL ACCUSATION: ${cardName(suspect)}, with the ${cardName(weapon)}, in the ${roomById[room].name}!`);
      const ok = suspect === s.solution.suspect && weapon === s.solution.weapon && room === s.solution.room;
      if (ok) {
        s.over = true; s.winner = me.id; s.phase = 'over';
        addLog(s, `${me.name} is RIGHT and wins the game!`);
      } else {
        me.eliminated = true;
        addLog(s, `${me.name} was wrong and is out of the game (but must still show cards).`);
        const left = activePlayers(s);
        if (left.length === 1) {
          s.over = true; s.winner = left[0].id; s.winnerByDefault = true; s.phase = 'over';
          addLog(s, `${left[0].name} is the last detective standing and wins by default.`);
        } else {
          advanceTurn(s);
        }
      }
      return { ok: true, state: s };
    }

    case 'endTurn': {
      if (!['start', 'move', 'suggest', 'post'].includes(s.phase)) return err("You can't end your turn now.");
      addLog(s, `${me.name} ends their turn.`);
      advanceTurn(s);
      return { ok: true, state: s };
    }

    default:
      return err('Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Views: what ONE player is allowed to know. The envelope and other players'
// hands never leave the host; each client only ever receives its own view.
// ---------------------------------------------------------------------------
export function legalActions(s, playerId) {
  const none = { roll: false, passage: false, stay: false, suggest: false, accuse: false, endTurn: false, refute: false };
  const me = s.players.find(p => p.id === playerId);
  if (!me || s.over) return none;
  if (s.phase === 'refute') return { ...none, refute: !!s.pending && s.pending.refuter === playerId };
  if (current(s).id !== playerId) return none;
  const pos = s.tokens.suspects[me.suspect];
  return {
    roll: s.phase === 'start',
    passage: s.phase === 'start' && !!pos.room && !!PASSAGES[pos.room],
    stay: s.phase === 'start' && !!pos.room && !!s.movedBy[me.id],
    suggest: s.phase === 'suggest',
    accuse: true,
    endTurn: true,
    refute: false,
  };
}

export function viewFor(s, playerId) {
  const me = s.players.find(p => p.id === playerId) || null;
  const cur = current(s);
  const actor = s.phase === 'refute' && s.pending ? s.pending.refuter : cur.id;
  const view = {
    you: playerId, gameId: s.id,
    phase: s.phase, turnNo: s.turnNo,
    turn: cur.id, actor,
    dice: s.dice, rolled: s.rolled,
    players: s.players.map(p => ({
      id: p.id, name: p.name, suspect: p.suspect,
      eliminated: p.eliminated, handCount: p.hand.length,
    })),
    tokens: s.tokens,
    hand: me ? me.hand : [],
    faceUp: s.faceUp,
    shown: s.shown.filter(x => x.to === playerId).map(({ by, card }) => ({ by, card })),
    log: s.log.filter(l => l.to === null || l.to === playerId),
    can: legalActions(s, playerId),
    moves: null,
    pending: null,
    over: s.over, winner: s.winner, winnerByDefault: s.winnerByDefault,
    solution: s.over ? s.solution : null,
  };
  if (s.phase === 'move' && cur.id === playerId) {
    const r = reachable(s, me.suspect, s.rolled);
    view.moves = { tiles: r.tiles, rooms: r.rooms };
  }
  if (s.pending) {
    view.pending = {
      suggester: s.pending.suggester, refuter: s.pending.refuter,
      suspect: s.pending.suspect, weapon: s.pending.weapon, room: s.pending.room,
      options: s.pending.refuter === playerId ? s.pending.options : null,
    };
  }
  return view;
}
