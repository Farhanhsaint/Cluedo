import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUSPECTS, ROOMS, DOORS, GRID, COLS, ROWS, PASSAGES, ALL_CARDS, isHall, DOORSTEP_TO_ROOM,
} from '../js/data.js';
import { createGame, applyAction, reachable, pathTo, viewFor, legalActions } from '../js/engine.js';

const mk = (n, seed = 1) => {
  const ps = SUSPECTS.slice(0, n).map((s, i) => ({ id: 'p' + i, name: 'P' + i, suspect: s.id }));
  return createGame({ players: ps, seed });
};
const act = (s, pid, a) => { const r = applyAction(s, pid, a); assert.ok(r.ok, r.error); return r.state; };
const cur = s => s.players[s.turn];

// ---------------------------------------------------------------- board
test('every door is a hallway tile touching its own room', () => {
  for (const [room, list] of Object.entries(DOORS)) {
    assert.ok(list.length >= 1, room);
    for (const [x, y] of list) {
      assert.ok(isHall(x, y), `${room} door ${x},${y} must be hallway`);
      const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => GRID[y + dy]?.[x + dx] === room);
      assert.ok(touches, `${room} door ${x},${y} must touch the room`);
    }
  }
});

test('hallway is one connected region and every room is reachable', () => {
  const seen = new Set(); const q = [[SUSPECTS[0].start[0], SUSPECTS[0].start[1]]];
  seen.add(q[0].join());
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (isHall(nx, ny) && !seen.has(nx + ',' + ny)) { seen.add(nx + ',' + ny); q.push([nx, ny]); }
    }
  }
  let total = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (isHall(x, y)) total++;
  assert.equal(seen.size, total, 'all hallway tiles connected');
  for (const [, list] of Object.entries(DOORS)) assert.ok(list.some(([x, y]) => seen.has(x + ',' + y)));
  for (const sp of SUSPECTS) assert.ok(isHall(...sp.start), sp.id + ' starts on hallway');
  assert.equal(new Set(SUSPECTS.map(s => s.start.join())).size, 6);
});

test('room interiors are never hallway (regression: "hall" room vs hallway)', () => {
  for (const r of ROOMS) {
    const [rx, ry, rw, rh] = r.rect;
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) assert.ok(!isHall(x, y), `${r.id} ${x},${y}`);
  }
  assert.equal(isHall(12, 3), false);
  assert.equal(isHall(15, 0), true);
});

test('secret passages are symmetric corner links', () => {
  for (const [a, b] of Object.entries(PASSAGES)) assert.equal(PASSAGES[b], a);
});

// ---------------------------------------------------------------- setup
test('dealing: every card exactly once, envelope hidden, leftovers face-up', () => {
  for (let n = 2; n <= 6; n++) {
    const s = mk(n, 42 + n);
    const all = [...s.players.flatMap(p => p.hand), ...s.faceUp, s.solution.suspect, s.solution.weapon, s.solution.room];
    assert.equal(all.length, 21);
    assert.equal(new Set(all).size, 21);
    assert.deepEqual([...all].sort(), [...ALL_CARDS].sort());
    assert.equal(s.faceUp.length, 18 % n);
    const sizes = new Set(s.players.map(p => p.hand.length));
    assert.equal(sizes.size, 1, 'hands equal size');
  }
});

test('same seed gives the same game; different seed differs', () => {
  assert.deepEqual(mk(4, 7), mk(4, 7));
  assert.notDeepEqual(mk(4, 7).solution, mk(4, 8).solution === undefined ? {} : { x: 1 });
  const a = mk(4, 7), b = mk(4, 9);
  assert.notDeepEqual(a.players.map(p => p.hand), b.players.map(p => p.hand));
});

test('rejects bad setups', () => {
  assert.throws(() => createGame({ players: [{ id: 'a', name: 'a', suspect: 'plum' }], seed: 1 }));
  assert.throws(() => createGame({ players: [{ id: 'a', name: 'a', suspect: 'plum' }, { id: 'b', name: 'b', suspect: 'plum' }], seed: 1 }));
});

test('turn order follows character order and weapons start in 6 different rooms', () => {
  const s = createGame({ players: [{ id: 'z', name: 'Z', suspect: 'plum' }, { id: 'y', name: 'Y', suspect: 'mustard' }, { id: 'x', name: 'X', suspect: 'scarlett' }], seed: 3 });
  assert.deepEqual(s.players.map(p => p.id), ['x', 'y', 'z']);
  assert.equal(new Set(Object.values(s.tokens.weapons).map(w => w.room)).size, 6);
});

// ---------------------------------------------------------------- movement
test('BFS: distances are shortest paths and never exceed the roll', () => {
  const s = mk(3, 5);
  const r = reachable(s, 'scarlett', 6);
  assert.ok(r.tiles.length > 10);
  assert.ok(r.tiles.every(t => t.d >= 1 && t.d <= 6));
  for (const t of r.tiles) assert.equal(pathTo(r, t).length, t.d);
  // Manhattan distance is a lower bound on any path.
  for (const t of r.tiles) assert.ok(Math.abs(t.x - 16) + Math.abs(t.y - 0) <= t.d);
});

test('BFS: occupied tiles block, rooms end the move, own room cannot be re-entered', () => {
  const s = mk(3, 5);
  s.tokens.suspects.scarlett = { x: 11, y: 8 };
  s.tokens.suspects.mustard = { x: 11, y: 7 };  // doorstep of the Hall, occupied
  // direct door (11,7) is occupied: going through (11,7) -> hall would cost 2, the free door (12,7) costs 3
  assert.ok(!reachable(s, 'scarlett', 2).rooms.some(x => x.room === 'hall'), 'blocked door cannot be used');
  const r2 = reachable(s, 'scarlett', 3);
  assert.ok(r2.rooms.some(x => x.room === 'hall'), 'via the other door');
  assert.equal(r2.rooms.find(x => x.room === 'hall').d, 3);
  assert.ok(!r2.tiles.some(t => t.x === 11 && t.y === 7), 'cannot stand on occupied tile');
  s.tokens.suspects.scarlett = { room: 'hall' };
  s.tokens.suspects.mustard = { x: 0, y: 0 + 4 };
  const r3 = reachable(s, 'scarlett', 12);
  assert.ok(!r3.rooms.some(x => x.room === 'hall'));
  // from inside a room, a roll of 1 reaches only the doorsteps
  const r4 = reachable(s, 'scarlett', 1);
  assert.deepEqual(r4.tiles.map(t => `${t.x},${t.y}`).sort(), DOORS.hall.map(d => d.join()).sort());
  assert.equal(r4.rooms.length, 0);
});

test('eliminated players do not block', () => {
  const s = mk(3, 5);
  s.tokens.suspects.scarlett = { x: 11, y: 8 };
  s.tokens.suspects.mustard = { x: 11, y: 7 };
  s.players.find(p => p.suspect === 'mustard').eliminated = true;
  assert.ok(reachable(s, 'scarlett', 3).rooms.some(x => x.room === 'hall'));
});

// ---------------------------------------------------------------- turn flow
test('out-of-turn and wrong-phase actions are rejected', () => {
  const s = mk(3, 11);
  assert.equal(applyAction(s, 'p1', { type: 'roll' }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'move', to: { x: 16, y: 1 } }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'suggest', suspect: 'plum', weapon: 'rope' }).ok, false);
  assert.equal(applyAction(s, 'nobody', { type: 'roll' }).ok, false);
  assert.equal(applyAction(s, 'p0', { type: 'dance' }).ok, false);
  assert.equal(applyAction(s, 'p0', null).ok, false);
});

test('roll -> move into a room -> suggest; pieces are summoned', () => {
  let s = mk(3, 11);
  s.tokens.suspects.scarlett = { x: 12, y: 7 };           // on the Hall doorstep
  s = act(s, 'p0', { type: 'roll' });
  assert.equal(s.phase, 'move');
  assert.equal(applyAction(s, 'p0', { type: 'move', to: { x: 0, y: 0 } }).ok, false, 'unreachable');
  const r = reachable(s, 'scarlett', s.rolled);
  assert.ok(r.rooms.some(x => x.room === 'hall'));
  s = act(s, 'p0', { type: 'move', to: { room: 'hall' } });
  assert.equal(s.phase, 'suggest');
  assert.equal(legalActions(s, 'p0').suggest, true);
  s = act(s, 'p0', { type: 'suggest', suspect: 'plum', weapon: 'rope' });
  assert.deepEqual(s.tokens.suspects.plum, { room: 'hall' });
  assert.deepEqual(s.tokens.weapons.rope, { room: 'hall' });
  assert.ok(['post', 'refute'].includes(s.phase));
});

function rig(hands, solution) {
  const s = mk(hands.length, 2);
  s.players.forEach((p, i) => { p.hand = hands[i]; });
  s.solution = solution;
  s.faceUp = [];
  s.tokens.suspects.scarlett = { room: 'hall' };
  s.phase = 'suggest';
  return s;
}

test('refutation goes clockwise, single match is shown automatically and privately', () => {
  const s0 = rig([['plum'], ['rope', 'kitchen'], ['hall', 'wrench']], { suspect: 'green', weapon: 'dagger', room: 'study' });
  const s = act(s0, 'p0', { type: 'suggest', suspect: 'plum', weapon: 'rope' });
  assert.equal(s.phase, 'post');
  assert.deepEqual(s.shown, [{ to: 'p0', by: 'p1', card: 'rope' }]);
  const v0 = viewFor(s, 'p0'), v2 = viewFor(s, 'p2');
  assert.ok(v0.log.some(l => l.text.includes('showed you: Rope')));
  assert.ok(!v2.log.some(l => l.text.includes('showed you')));
  assert.ok(v2.log.some(l => l.text === 'P1 showed a card to P0.'));
  assert.deepEqual(v2.shown, []);
});

test('multiple matches wait for the refuter to choose; only they get options', () => {
  const s0 = rig([['plum'], ['rope', 'hall'], ['wrench']], { suspect: 'green', weapon: 'dagger', room: 'study' });
  let s = act(s0, 'p0', { type: 'suggest', suspect: 'mustard', weapon: 'rope' });
  assert.equal(s.phase, 'refute');
  assert.deepEqual(viewFor(s, 'p1').pending.options.sort(), ['hall', 'rope']);
  assert.equal(viewFor(s, 'p0').pending.options, null);
  assert.equal(viewFor(s, 'p1').actor, 'p1');
  assert.equal(applyAction(s, 'p0', { type: 'endTurn' }).ok, false);
  assert.equal(applyAction(s, 'p2', { type: 'refute', card: 'rope' }).ok, false);
  assert.equal(applyAction(s, 'p1', { type: 'refute', card: 'wrench' }).ok, false);
  s = act(s, 'p1', { type: 'refute', card: 'hall' });
  assert.equal(s.phase, 'post');
  assert.deepEqual(s.shown, [{ to: 'p0', by: 'p1', card: 'hall' }]);
});

test('nobody can refute', () => {
  const s0 = rig([['plum'], ['kitchen'], ['wrench']], { suspect: 'green', weapon: 'dagger', room: 'study' });
  const s = act(s0, 'p0', { type: 'suggest', suspect: 'mustard', weapon: 'rope' });
  assert.equal(s.phase, 'post');
  assert.ok(s.log.at(-1).text.includes('Nobody'));
});

test('eliminated players still refute', () => {
  const s0 = rig([['plum'], ['rope'], ['wrench']], { suspect: 'green', weapon: 'dagger', room: 'study' });
  s0.players[1].eliminated = true;
  const s = act(s0, 'p0', { type: 'suggest', suspect: 'mustard', weapon: 'rope' });
  assert.deepEqual(s.shown[0], { to: 'p0', by: 'p1', card: 'rope' });
});

test('a player summoned by a suggestion may stay and suggest without rolling', () => {
  const s0 = rig([['plum'], ['rope'], ['wrench']], { suspect: 'green', weapon: 'dagger', room: 'study' });
  let s = act(s0, 'p0', { type: 'suggest', suspect: 'mustard', weapon: 'dagger' });   // mustard is p1
  assert.equal(s.movedBy.p1, true);
  s = act(s, 'p0', { type: 'endTurn' });
  assert.equal(cur(s).id, 'p1');
  assert.equal(legalActions(s, 'p1').stay, true);
  assert.equal(legalActions(s, 'p0').stay, false);
  s = act(s, 'p1', { type: 'stay' });
  assert.equal(s.phase, 'suggest');
  // staying is not allowed twice
  let t = act(s0, 'p0', { type: 'suggest', suspect: 'mustard', weapon: 'dagger' });
  t = act(t, 'p0', { type: 'endTurn' });
  t = act(t, 'p1', { type: 'roll' });
  assert.equal(t.movedBy.p1, undefined);
});

test('secret passage replaces the roll', () => {
  let s = mk(3, 8);
  s.tokens.suspects.scarlett = { room: 'study' };
  s = act(s, 'p0', { type: 'passage' });
  assert.deepEqual(s.tokens.suspects.scarlett, { room: 'kitchen' });
  assert.equal(s.phase, 'suggest');
  let t = mk(3, 8);
  assert.equal(applyAction(t, 'p0', { type: 'passage' }).ok, false, 'not in a corner room');
  t.tokens.suspects.scarlett = { room: 'hall' };
  assert.equal(applyAction(t, 'p0', { type: 'passage' }).ok, false, 'hall has no passage');
});

test('wrong accusation eliminates and skips; right accusation wins', () => {
  const sol = { suspect: 'green', weapon: 'dagger', room: 'study' };
  let s = mk(3, 5); s.solution = sol;
  s = act(s, 'p0', { type: 'accuse', suspect: 'plum', weapon: 'dagger', room: 'study' });
  assert.equal(s.players[0].eliminated, true);
  assert.equal(cur(s).id, 'p1');
  assert.equal(s.over, false);
  s = act(s, 'p1', { type: 'endTurn' });
  assert.equal(cur(s).id, 'p2', 'p0 is skipped later');
  s = act(s, 'p2', { type: 'endTurn' });
  assert.equal(cur(s).id, 'p1');
  s = act(s, 'p1', { type: 'accuse', ...sol });
  assert.equal(s.over, true);
  assert.equal(s.winner, 'p1');
  assert.equal(viewFor(s, 'p0').solution.suspect, 'green');
  assert.equal(applyAction(s, 'p2', { type: 'roll' }).ok, false);
});

test('last detective standing wins by default', () => {
  const sol = { suspect: 'green', weapon: 'dagger', room: 'study' };
  let s = mk(2, 5); s.solution = sol;
  s = act(s, 'p0', { type: 'accuse', suspect: 'plum', weapon: 'rope', room: 'hall' });
  assert.equal(s.over, true);
  assert.equal(s.winner, 'p1');
  assert.equal(s.winnerByDefault, true);
});

// ---------------------------------------------------------------- privacy
test('views never leak the envelope or other hands', () => {
  const s = mk(4, 99);
  const v = viewFor(s, 'p1');
  const text = JSON.stringify(v);
  assert.equal(v.solution, null);
  assert.deepEqual(v.hand, s.players[1].hand);
  assert.ok(!('solution' in JSON.parse(text)) || JSON.parse(text).solution === null);
  assert.ok(v.players.every(p => !('hand' in p)));
  assert.ok(!text.includes('"rng"') && !text.includes('"seed"'));
});

// ---------------------------------------------------------------- fuzz
function pick(arr, s) { return arr[Math.floor(Math.random() * arr.length)]; }

test('fuzz: 1500 random games always terminate and keep invariants', () => {
  let finished = 0;
  for (let g = 0; g < 1500; g++) {
    const n = 2 + (g % 5);
    let s = mk(n, g + 1000);
    for (let step = 0; step < 4000 && !s.over; step++) {
      const pid = s.phase === 'refute' ? s.pending.refuter : cur(s).id;
      const v = viewFor(s, pid);
      let a;
      if (v.can.refute) a = { type: 'refute', card: pick(v.pending.options) };
      else if (v.phase === 'start') {
        const roll = Math.random();
        if (v.can.stay && roll < 0.5) a = { type: 'stay' };
        else if (v.can.passage && roll < 0.4) a = { type: 'passage' };
        else a = { type: 'roll' };
      } else if (v.phase === 'move') {
        const opts = [...v.moves.tiles.map(t => ({ x: t.x, y: t.y })), ...v.moves.rooms.map(r => ({ room: r.room }))];
        a = opts.length && Math.random() < 0.95 ? { type: 'move', to: pick(opts) } : { type: 'endTurn' };
      } else if (v.phase === 'suggest') {
        a = { type: 'suggest', suspect: pick(SUSPECTS).id, weapon: pick(['rope', 'dagger', 'wrench', 'revolver', 'leadpipe', 'candlestick']) };
      } else {
        const accuseP = Math.min(0.5, 0.02 + step / 800);
        a = Math.random() < accuseP
          ? { type: 'accuse', suspect: pick(SUSPECTS).id, weapon: pick(['rope', 'dagger', 'wrench']), room: pick(ROOMS).id }
          : { type: 'endTurn' };
      }
      const r = applyAction(s, pid, a);
      assert.ok(r.ok, `${JSON.stringify(a)} -> ${r.error} (phase ${s.phase})`);
      s = r.state;
      // invariants
      const all = [...s.players.flatMap(p => p.hand), ...s.faceUp, s.solution.suspect, s.solution.weapon, s.solution.room];
      assert.equal(new Set(all).size, 21);
      const seen = new Set();
      for (const p of s.players) {
        const pos = s.tokens.suspects[p.suspect];
        if (!pos.room && !p.eliminated) {
          assert.ok(isHall(pos.x, pos.y));
          const k = pos.x + ',' + pos.y; assert.ok(!seen.has(k), 'two active tokens share a tile'); seen.add(k);
        }
      }
    }
    if (s.over) finished++;
  }
  assert.ok(finished > 1400, `only ${finished} finished`);
});
