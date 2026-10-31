// host.js — the "referee". It owns the lobby and the ONE authoritative game state.
//
// CONCEPT — authoritative host + thin clients. Clients never see the real state;
// they send *intents* ({t:'action', action:{type:'roll'}}) and receive a
// *projection* (engine.viewFor) containing only what that player may know.
// This class is transport-agnostic: it just calls `emit(connId, message)`.
// In the browser the transport is WebRTC (net.js); in tests it is a plain function.

import { SUSPECT_IDS } from './data.js';
import { createGame, applyAction, viewFor } from './engine.js';

const MAX_PLAYERS = 6;

const randomToken = () => {
  const a = new Uint8Array(12);
  (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); });
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
};

export class GameHost {
  /**
   * @param {object} o
   * @param {(connId:string, msg:object)=>void} o.emit  how to reach a connection
   * @param {string} o.roomCode
   * @param {boolean} [o.hotseat]  everyone shares one device (connId 'host')
   * @param {(json:object)=>void} [o.onSave] called after every change so the host can resume after a refresh
   */
  constructor({ emit, roomCode, hotseat = false, onSave = null }) {
    this.emit = emit;
    this.roomCode = roomCode;
    this.hotseat = hotseat;
    this.onSave = onSave;
    this.players = [];     // lobby seats: {id,name,suspect,token,connId,connected,isHost}
    this.started = false;
    this.game = null;
    this.nextId = 1;
  }

  // ---- persistence (also used for "Save game" download) --------------------
  serialize() {
    return {
      v: 1, roomCode: this.roomCode, hotseat: this.hotseat, started: this.started,
      nextId: this.nextId, game: this.game,
      players: this.players.map(({ id, name, suspect, token, isHost }) => ({ id, name, suspect, token, isHost })),
    };
  }
  static restore(save, opts) {
    const h = new GameHost({ ...opts, roomCode: save.roomCode, hotseat: !!save.hotseat });
    h.started = !!save.started;
    h.nextId = save.nextId || 1;
    h.game = save.game || null;
    h.players = save.players.map(p => ({ ...p, connId: null, connected: false }));
    if (h.hotseat) h.players.forEach(p => { p.connId = 'host'; p.connected = true; });
    return h;
  }
  _changed() { if (this.onSave) { try { this.onSave(this.serialize()); } catch { /* storage may be full or blocked */ } } }

  // ---- lobby ---------------------------------------------------------------
  lobbyInfo() {
    return {
      roomCode: this.roomCode, started: this.started, hotseat: this.hotseat,
      players: this.players.map(p => ({ id: p.id, name: p.name, suspect: p.suspect, connected: p.connected, isHost: p.isHost })),
      canStart: !this.started && this.players.length >= 2,
    };
  }

  snapshotFor(playerId) {
    return {
      lobby: this.lobbyInfo(),
      you: playerId,
      view: this.game && this.players.some(p => p.id === playerId) ? viewFor(this.game, playerId) : null,
    };
  }

  addPlayer({ name, suspect, connId, isHost = false }) {
    if (this.started) return { error: 'The game has already started.' };
    if (this.players.length >= MAX_PLAYERS) return { error: 'The room is full (6 players).' };
    const taken = new Set(this.players.map(p => p.suspect));
    if (!suspect || taken.has(suspect) || !SUSPECT_IDS.includes(suspect)) suspect = SUSPECT_IDS.find(s => !taken.has(s));
    let clean = String(name || 'Player').trim().slice(0, 20) || 'Player';
    const names = new Set(this.players.map(p => p.name.toLowerCase()));
    for (let i = 2; names.has(clean.toLowerCase()); i++) clean = `${String(name).trim().slice(0, 17)} ${i}`;
    const p = { id: 'p' + this.nextId++, name: clean, suspect, token: randomToken(), connId, connected: true, isHost };
    this.players.push(p);
    return { player: p };
  }

  // ---- incoming messages ---------------------------------------------------
  /** Everything a connection can say. Never trust the payload: validate everything. */
  onMessage(connId, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    const me = this._playerFor(connId, msg);

    switch (msg.t) {
      case 'join': {
        // Reconnect: same secret token -> same seat (survives refreshes and dropped connections).
        const back = !this.hotseat && msg.token && this.players.find(p => p.token === msg.token);
        if (back) {
          back.connId = connId; back.connected = true;
          this.emit(connId, { t: 'welcome', you: back.id, token: back.token });
        } else {
          const r = this.addPlayer({ name: msg.name, suspect: msg.suspect, connId, isHost: this.players.length === 0 && connId === 'host' });
          if (r.error) return this.emit(connId, { t: 'error', error: r.error });
          this.emit(connId, { t: 'welcome', you: r.player.id, token: r.player.token });
        }
        break;
      }
      case 'pick': {
        if (!me || this.started) return;
        if (!SUSPECT_IDS.includes(msg.suspect) || this.players.some(p => p.suspect === msg.suspect && p !== me)) {
          return this.emit(connId, { t: 'error', error: 'That character is taken.' });
        }
        me.suspect = msg.suspect;
        break;
      }
      case 'rename': {
        if (!me || this.started) return;
        const nm = String(msg.name || '').trim().slice(0, 20);
        if (nm && !this.players.some(p => p !== me && p.name.toLowerCase() === nm.toLowerCase())) me.name = nm;
        break;
      }
      case 'kick': {
        if (!me || !me.isHost || this.started) return;
        const victim = this.players.find(p => p.id === msg.id);
        if (!victim || victim === me) return;
        this.players = this.players.filter(p => p !== victim);
        if (victim.connId) this.emit(victim.connId, { t: 'kicked' });
        break;
      }
      case 'start': {
        if (!me || !me.isHost || this.started) return;
        if (this.players.length < 2) return this.emit(connId, { t: 'error', error: 'You need at least 2 players.' });
        this.game = createGame({
          players: this.players.map(p => ({ id: p.id, name: p.name, suspect: p.suspect })),
          seed: (Math.random() * 2 ** 32) >>> 0,
          id: randomToken().slice(0, 8),
        });
        this.started = true;
        break;
      }
      case 'action': {
        if (!me || !this.started || !this.game) return;
        const r = applyAction(this.game, me.id, msg.action);
        if (!r.ok) return this.emit(connId, { t: 'error', error: r.error });
        this.game = r.state;
        break;
      }
      case 'rematch': {
        if (!me || !me.isHost || !this.game || !this.game.over) return;
        this.game = null; this.started = false;
        break;
      }
      default: return;
    }
    this._changed();
    this.publish();
  }

  onDisconnect(connId) {
    let any = false;
    for (const p of this.players) if (p.connId === connId && p.connected) { p.connected = false; any = true; }
    if (any) this.publish();
  }

  /** In hotseat one device plays every seat, so the sender names the seat via msg.as. */
  _playerFor(connId, msg) {
    if (this.hotseat && connId === 'host') return this.players.find(p => p.id === msg.as) || null;
    return this.players.find(p => p.connId === connId) || null;
  }

  // ---- outgoing ------------------------------------------------------------
  publish() {
    if (this.hotseat) return this.emit('host', { t: 'tick' });     // UI pulls the seat it needs
    const sent = new Set();
    for (const p of this.players) {
      if (!p.connected || !p.connId) continue;
      this.emit(p.connId, { t: 'state', ...this.snapshotFor(p.id) });
      sent.add(p.connId);
    }
  }
}
