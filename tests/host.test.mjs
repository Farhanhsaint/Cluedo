import test from 'node:test';
import assert from 'node:assert/strict';
import { GameHost } from '../js/host.js';

// A fake network: connection id -> inbox of messages the host sent it.
function rig(opts = {}) {
  const inbox = new Map();
  const emit = (id, msg) => { if (!inbox.has(id)) inbox.set(id, []); inbox.get(id).push(msg); };
  const host = new GameHost({ emit, roomCode: 'ABCDE', ...opts });
  const last = (id, t) => [...(inbox.get(id) || [])].reverse().find(m => m.t === t);
  return { host, inbox, last };
}

function lobby3() {
  const r = rig();
  r.host.onMessage('host', { t: 'join', name: 'Ann' });
  r.host.onMessage('c1', { t: 'join', name: 'Bob' });
  r.host.onMessage('c2', { t: 'join', name: 'Cy' });
  return r;
}

test('players join, get unique characters and a secret token', () => {
  const r = lobby3();
  const ps = r.host.players;
  assert.equal(ps.length, 3);
  assert.equal(new Set(ps.map(p => p.suspect)).size, 3);
  assert.equal(ps[0].isHost, true);
  assert.equal(ps[1].isHost, false);
  const w = r.last('c1', 'welcome');
  assert.equal(w.you, ps[1].id);
  assert.ok(w.token.length >= 16);
  // tokens never leak into anyone's lobby view
  assert.ok(!JSON.stringify(r.last('c2', 'state')).includes(w.token));
});

test('duplicate names are made unique and picking a taken character fails', () => {
  const r = lobby3();
  r.host.onMessage('c3', { t: 'join', name: 'Ann' });
  assert.deepEqual(new Set(r.host.players.map(p => p.name)).size, 4);
  const taken = r.host.players[0].suspect;
  r.host.onMessage('c1', { t: 'pick', suspect: taken });
  assert.equal(r.last('c1', 'error').error, 'That character is taken.');
  r.host.onMessage('c1', { t: 'pick', suspect: 'plum' });
  assert.equal(r.host.players[1].suspect, 'plum');
});

test('only the host can start; needs 2 players; then nobody can join', () => {
  const r = rig();
  r.host.onMessage('host', { t: 'join', name: 'Ann' });
  r.host.onMessage('host', { t: 'start' });
  assert.equal(r.host.started, false);
  r.host.onMessage('c1', { t: 'join', name: 'Bob' });
  r.host.onMessage('c1', { t: 'start' });
  assert.equal(r.host.started, false, 'non-host cannot start');
  r.host.onMessage('host', { t: 'start' });
  assert.equal(r.host.started, true);
  r.host.onMessage('c9', { t: 'join', name: 'Late' });
  assert.match(r.last('c9', 'error').error, /already started/);
});

test('each player only receives their own hand; the envelope never travels', () => {
  const r = lobby3();
  r.host.onMessage('host', { t: 'start' });
  const hands = r.host.players.map(p => p.id);
  const conns = ['host', 'c1', 'c2'];
  conns.forEach((c, i) => {
    const st = r.last(c, 'state');
    assert.equal(st.you, hands[i]);
    assert.deepEqual(st.view.hand, r.host.game.players[i].hand);
    assert.equal(st.view.solution, null);
    const raw = JSON.stringify(st);
    for (const [j, p] of r.host.game.players.entries()) {
      if (j !== i) assert.ok(!raw.includes('"hand":' + JSON.stringify(p.hand)), 'other hand leaked');
    }
    assert.ok(!raw.includes(JSON.stringify(r.host.game.solution)));
  });
});

test('actions are attributed to the connection, not to anything the sender claims', () => {
  const r = lobby3();
  r.host.onMessage('host', { t: 'start' });
  const first = r.host.game.players[0].id;     // whoever goes first
  const connOf = id => r.host.players.find(p => p.id === id).connId;
  const other = r.host.players.find(p => p.id !== first).connId;
  r.host.onMessage(other, { t: 'action', action: { type: 'roll' }, as: first });
  assert.match(r.last(other, 'error').error, /isn't your turn/);
  r.host.onMessage(connOf(first), { t: 'action', action: { type: 'roll' } });
  assert.equal(r.host.game.phase, 'move');
  // garbage never crashes the host
  for (const junk of [null, 5, {}, { t: 7 }, { t: 'action' }, { t: 'action', action: 3 }, { t: 'pick', suspect: {} }]) {
    assert.doesNotThrow(() => r.host.onMessage('c1', junk));
  }
});

test('reconnect with the token restores the same seat; disconnect is visible to others', () => {
  const r = lobby3();
  const tok = r.last('c1', 'welcome').token, id = r.last('c1', 'welcome').you;
  r.host.onMessage('host', { t: 'start' });
  r.host.onDisconnect('c1');
  assert.equal(r.last('host', 'state').lobby.players.find(p => p.id === id).connected, false);
  r.host.onMessage('c1-new', { t: 'join', name: 'Bob again', token: tok });
  assert.equal(r.last('c1-new', 'welcome').you, id);
  assert.equal(r.host.players.length, 3);
  assert.equal(r.last('c1-new', 'state').view.hand.length, r.host.game.players.find(p => p.id === id).hand.length);
  // a wrong token is NOT a way into the game
  r.host.onMessage('evil', { t: 'join', name: 'Eve', token: 'nope' });
  assert.match(r.last('evil', 'error').error, /already started/);
});

test('save / restore: the whole game survives a host refresh', () => {
  const r = lobby3();
  r.host.onMessage('host', { t: 'start' });
  const hostTok = r.host.players[0].token;
  const first = r.host.game.players[0].id;
  r.host.onMessage(r.host.players.find(p => p.id === first).connId, { t: 'action', action: { type: 'roll' } });
  const saved = JSON.parse(JSON.stringify(r.host.serialize()));
  const r2 = rig();
  const h2 = GameHost.restore(saved, { emit: (id, m) => { (r2.inbox.get(id) || r2.inbox.set(id, []).get(id)).push(m); } });
  assert.deepEqual(h2.game, r.host.game);
  assert.ok(h2.players.every(p => !p.connected));
  h2.onMessage('host', { t: 'join', token: hostTok });
  assert.equal(h2.players[0].connected, true);
  assert.equal(h2.players[0].connId, 'host');
});

test('kick and rematch', () => {
  const r = lobby3();
  const victim = r.host.players[2].id;
  r.host.onMessage('c1', { t: 'kick', id: victim });
  assert.equal(r.host.players.length, 3, 'non-host cannot kick');
  r.host.onMessage('host', { t: 'kick', id: victim });
  assert.equal(r.host.players.length, 2);
  assert.ok(r.last('c2', 'kicked'));
  r.host.onMessage('host', { t: 'start' });
  r.host.onMessage('host', { t: 'rematch' });
  assert.equal(r.host.started, true, 'cannot rematch mid-game');
  r.host.game.over = true;
  r.host.onMessage('host', { t: 'rematch' });
  assert.equal(r.host.started, false);
  assert.equal(r.host.game, null);
});

test('hotseat: one connection plays every seat via "as"', () => {
  const r = rig({ hotseat: true });
  r.host.addPlayer({ name: 'A', suspect: 'scarlett', connId: 'host', isHost: true });
  r.host.addPlayer({ name: 'B', suspect: 'mustard', connId: 'host' });
  r.host.onMessage('host', { t: 'start', as: r.host.players[0].id });
  assert.equal(r.host.started, true);
  r.host.onMessage('host', { t: 'action', as: r.host.players[1].id, action: { type: 'roll' } });
  assert.match(r.last('host', 'error').error, /isn't your turn/);
  r.host.onMessage('host', { t: 'action', as: r.host.players[0].id, action: { type: 'roll' } });
  assert.equal(r.host.game.phase, 'move');
});
