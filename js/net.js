// net.js — thin wrappers around PeerJS (WebRTC data channels).
//
// CONCEPT — how two browsers find each other without a game server:
//   1. Every browser opens a WebSocket to a small public "broker" (PeerJS cloud).
//      The broker only introduces peers and relays the connection setup ("signalling").
//   2. The browsers swap network addresses (ICE candidates, learned via STUN servers)
//      and open a direct encrypted channel. Game messages then flow browser-to-browser.
//   3. If a strict NAT/firewall blocks the direct path, a TURN relay is needed (see README).
// The host's peer id IS the room code, so a friend types the code and connects to it.

const PREFIX = 'cluedo-fh-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';   // no I or L or O-lookalikes

export function newRoomCode() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return [...a].map(n => ALPHABET[n % ALPHABET.length]).join('');
}
export const normalizeCode = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);

/** Config comes from the URL so tests (or you) can point at a different broker or TURN server:
 *  ?peerHost=localhost&peerPort=9000&peerPath=/&peerSecure=0   ?turn=turn:host:3478,user,pass */
export function peerConfig() {
  const q = new URLSearchParams(globalThis.location ? location.search : '');
  const cfg = { debug: 1 };
  if (q.get('peerHost')) {
    cfg.host = q.get('peerHost');
    cfg.port = Number(q.get('peerPort') || 9000);
    cfg.path = q.get('peerPath') || '/';
    cfg.secure = q.get('peerSecure') === '1';
  }
  const ice = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (q.get('turn')) {
    const [urls, username, credential] = q.get('turn').split(',');
    ice.push({ urls, username, credential });
  }
  cfg.config = { iceServers: ice };
  return cfg;
}

function requirePeer() {
  if (typeof Peer === 'undefined') throw new Error('PeerJS failed to load, so online play is unavailable.');
}

/** HOST side: accepts many connections, routes their messages to GameHost. */
export function openHostPeer(code, { onMessage, onDisconnect, onReady, onError }) {
  requirePeer();
  const conns = new Map();   // connId -> DataConnection
  const lastSeen = new Map();
  const peer = new Peer(PREFIX + code, peerConfig());
  // WebRTC can take half a minute to notice a vanished peer, so we also run our own
  // heartbeat: clients ping every few seconds; silence means gone.
  const watchdog = setInterval(() => {
    for (const [id, c] of conns) if (Date.now() - (lastSeen.get(id) || 0) > 14000) { conns.delete(id); try { c.close(); } catch { /* ignore */ } onDisconnect(id); }
  }, 4000);
  const bye = () => { clearInterval(watchdog); try { peer.destroy(); } catch { /* ignore */ } };
  addEventListener('pagehide', bye);
  peer.on('open', () => onReady());
  peer.on('error', e => onError(e.type === 'unavailable-id' ? 'That room code is already in use. Try again.' : `Network error: ${e.type || e.message}`));
  // Losing the broker connection only hurts NEW joiners; keep trying to restore it.
  peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* destroyed */ } });
  peer.on('connection', conn => {
    conn.on('open', () => { conns.set(conn.peer, conn); lastSeen.set(conn.peer, Date.now()); });
    conn.on('data', data => {
      lastSeen.set(conn.peer, Date.now());
      if (data && data.t === 'ping') return conn.send({ t: 'pong' });
      onMessage(conn.peer, data);
    });
    const gone = () => { if (conns.get(conn.peer) === conn) { conns.delete(conn.peer); onDisconnect(conn.peer); } };
    conn.on('close', gone);
    conn.on('error', gone);
  });
  return {
    send(connId, msg) { const c = conns.get(connId); if (c && c.open) c.send(msg); },
    close(connId) { const c = conns.get(connId); if (c) c.close(); },
    destroy() { clearInterval(watchdog); removeEventListener('pagehide', bye); peer.destroy(); },
  };
}

/** CLIENT side: connects to the host, and quietly reconnects if the link drops. */
export function openClientPeer(code, { onOpen, onMessage, onStatus, onError }) {
  requirePeer();
  let peer = null, conn = null, stopped = false, tries = 0, timer = null, everConnected = false, lastRx = 0, beat = null;

  const fail = msg => { onError(msg); };
  const retry = () => {
    if (stopped) return;
    onStatus('reconnecting');
    clearTimeout(timer);
    timer = setTimeout(connect, Math.min(1000 * 2 ** tries++, 8000));
  };

  function connect() {
    if (stopped) return;
    try { peer && peer.destroy(); } catch { /* ignore */ }
    peer = new Peer(peerConfig());
    let opened = false;
    const giveUp = setTimeout(() => { if (!opened) { fail("Couldn't reach the room. Check the code, or your network may be blocking direct connections."); } }, 20000);
    peer.on('error', e => {
      clearTimeout(giveUp);
      // Before we ever connected, "unavailable" means a wrong code. After that it just means the host is
      // briefly gone (page refresh, wifi blip), so keep knocking for a couple of minutes.
      if (e.type === 'peer-unavailable') {
        if (everConnected && tries < 15) retry();
        else fail('Room not found. Check the code, and make sure the host has the game open.');
      } else if (tries < 6) retry();
      else fail(`Network error: ${e.type || e.message}`);
    });
    peer.on('open', () => {
      conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => { opened = true; everConnected = true; clearTimeout(giveUp); tries = 0; onStatus('connected'); onOpen(); });
      conn.on('data', m => { lastRx = Date.now(); if (!m || m.t !== 'pong') onMessage(m); });
      let dropped = false;
      const drop = () => { if (dropped) return; dropped = true; clearTimeout(giveUp); clearInterval(beat); if (opened) retry(); };
      conn.on('close', drop);
      clearInterval(beat);
      beat = setInterval(() => {
        if (!conn || !conn.open) return;
        conn.send({ t: 'ping' });
        if (Date.now() - lastRx > 12000) { try { conn.close(); } catch { /* ignore */ } drop(); }
      }, 4000);
      lastRx = Date.now();
      conn.on('error', () => { clearTimeout(giveUp); });
    });
  }
  addEventListener('pagehide', () => { try { peer && peer.destroy(); } catch { /* ignore */ } });
  connect();
  return {
    send(msg) { if (conn && conn.open) conn.send(msg); },
    leave() { stopped = true; clearTimeout(timer); clearInterval(beat); try { peer && peer.destroy(); } catch { /* ignore */ } },
  };
}
