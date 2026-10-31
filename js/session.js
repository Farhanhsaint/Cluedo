// session.js — gives the UI ONE simple interface, whichever way the game is wired:
//
//   hotseat : one device, everyone takes turns (a GameHost lives in this tab)
//   host    : this tab runs the GameHost AND plays; friends connect over WebRTC
//   client  : this tab only talks to a remote host
//
// The UI calls session.act({...}) and re-renders from session.snapshot whenever
// the session notifies it. It never needs to know which mode it is in.

import { GameHost } from './host.js';
import { newRoomCode, openHostPeer, openClientPeer } from './net.js';

const SAVE_KEY = 'cluedo.save.v1';
const CLIENT_KEY = code => `cluedo.client.${code}`;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
export const savedGame = () => store.get(SAVE_KEY);
export const forgetSavedGame = () => store.del(SAVE_KEY);

export class Session {
  constructor(mode) {
    this.mode = mode;                 // 'hotseat' | 'host' | 'client'
    this.status = 'connecting';       // connecting | ready | reconnecting | error | kicked
    this.error = null;
    this.snapshot = { lobby: null, you: null, view: null };
    this.viewer = null;               // hotseat only: whose eyes are on the screen
    this.listeners = new Set();
    this.toast = null;
    this.roomCode = null;
    this.host = null;
    this.net = null;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _notify() { for (const fn of this.listeners) fn(this); }
  _toast(text) { this.toast = { text, at: Date.now() }; this._notify(); }

  /** Everything the host or client can receive funnels through here. */
  _receive(msg) {
    switch (msg.t) {
      case 'welcome':
        this.snapshot.you = msg.you;
        if (this.mode === 'client') store.set(CLIENT_KEY(this.roomCode), { token: msg.token, you: msg.you });
        break;
      case 'state':
        this.snapshot = { lobby: msg.lobby, you: msg.you, view: msg.view };
        this.status = 'ready';
        break;
      case 'tick': this._refreshHotseat(); break;
      case 'error':
        // An error before we ever got a seat (full room, game already started...) is fatal for this attempt.
        if (this.mode === 'client' && !this.snapshot.you) { this.status = 'error'; this.error = msg.error; break; }
        this._toast(msg.error); return;
      case 'kicked': this.status = 'kicked'; break;
      default: return;
    }
    this._notify();
  }

  _refreshHotseat() {
    if (!this.host) return;
    const g = this.host.game;
    if (g && !g.over) {
      // Whoever must act next (current player, or the refuter) gets the screen.
      this.viewer = g.phase === 'refute' && g.pending ? g.pending.refuter : g.players[g.turn].id;
    } else if (g) {
      this.viewer = this.viewer || g.players[0].id;
    }
    this.snapshot = this.host.snapshotFor(this.viewer || (this.host.players[0] && this.host.players[0].id));
    this.status = 'ready';
  }

  // ---- what the UI can ask for ----
  _send(msg) {
    if (this.mode === 'client') return this.net && this.net.send(msg);
    const as = this.mode === 'hotseat' ? this.viewer || (this.host.players[0] || {}).id : undefined;
    this.host.onMessage('host', as ? { ...msg, as } : msg);
  }
  act(action) { this._send({ t: 'action', action }); }
  pick(suspect) { this._send({ t: 'pick', suspect }); }
  rename(name) { this._send({ t: 'rename', name }); }
  start() { this._send({ t: 'start' }); }
  kick(id) { this._send({ t: 'kick', id }); }
  rematch() { this._send({ t: 'rematch' }); }
  exportSave() { return this.host ? this.host.serialize() : null; }

  leave() {
    if (this.net) { this.net.leave ? this.net.leave() : this.net.destroy(); }
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------- hotseat
export function createHotseat(seats, resume = null) {
  const s = new Session('hotseat');
  s.roomCode = 'LOCAL';
  const emit = (_c, msg) => s._receive(msg);
  const onSave = json => store.set(SAVE_KEY, json);
  if (resume) {
    s.host = GameHost.restore(resume, { emit, onSave });
  } else {
    s.host = new GameHost({ emit, roomCode: 'LOCAL', hotseat: true, onSave });
    seats.forEach((p, i) => s.host.addPlayer({ name: p.name, suspect: p.suspect, connId: 'host', isHost: i === 0 }));
    s.host.onMessage('host', { t: 'start', as: s.host.players[0].id });
  }
  s._refreshHotseat();
  return s;
}

// ---------------------------------------------------------------- host
export function createHostSession(name, resume = null) {
  const s = new Session('host');
  const code = resume ? resume.roomCode : newRoomCode();
  s.roomCode = code;
  const emit = (connId, msg) => (connId === 'host' ? s._receive(msg) : s.net && s.net.send(connId, msg));
  const onSave = json => store.set(SAVE_KEY, json);
  s.host = resume ? GameHost.restore(resume, { emit, onSave }) : new GameHost({ emit, roomCode: code, onSave });
  try {
    s.net = openHostPeer(code, {
      onMessage: (id, m) => s.host.onMessage(id, m),
      onDisconnect: id => s.host.onDisconnect(id),
      onReady: () => {
        const mine = resume && resume.players.find(p => p.isHost);
        s.host.onMessage('host', { t: 'join', name, token: mine ? mine.token : undefined });
      },
      onError: msg => { s.status = 'error'; s.error = msg; s._notify(); },
    });
  } catch (e) { s.status = 'error'; s.error = e.message; }
  return s;
}

// ---------------------------------------------------------------- client
export function createClientSession(code, name) {
  const s = new Session('client');
  s.roomCode = code;
  try {
    s.net = openClientPeer(code, {
      // Read the token at connect time: after a dropped link we must present the one we were given.
      onOpen: () => { const saved = store.get(CLIENT_KEY(code)); s.net.send({ t: 'join', name, token: saved ? saved.token : undefined }); },
      onMessage: m => s._receive(m),
      onStatus: st => { if (st === 'reconnecting') s.status = 'reconnecting'; s._notify(); },
      onError: msg => { s.status = 'error'; s.error = msg; s._notify(); },
    });
  } catch (e) { s.status = 'error'; s.error = e.message; }
  return s;
}
