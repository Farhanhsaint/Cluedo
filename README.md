# Cluedo · friends edition

A complete Cluedo-style whodunit that runs entirely in the browser. No backend: it is a static site you can host free on **GitHub Pages**, and friends play together over **WebRTC peer-to-peer**.

Features: 2–6 players, character picking, 2d6 dice, board with doors / secret passages / blocking, suggestions with clockwise refutation, private card showing, final accusations and elimination, face-up leftover cards, detective notebook (auto-filled), reconnect after refresh, host save/resume, and a pass-and-play mode for one device.

> Unofficial fan project for private play. Not affiliated with or endorsed by Hasbro.

## Put it online (5 minutes)
1. Create a GitHub repo and push this folder to the `main` branch.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions** (the included workflow runs the tests, then deploys). Or choose "Deploy from a branch" and pick `main` / root.
3. Open `https://<you>.github.io/<repo>/`, type your name, **Create room**, and send friends the invite link (or the 5-letter code).

Keep the host's tab open while playing. If it closes or refreshes, press **Resume** on the home page; guests reconnect automatically and keep their seats and hands.

## Run locally
```
npm start        # serves http://localhost:8080  (any static server works)
npm test         # 32 tests: rules, board, dealing, host protocol, 1500 fuzzed games
```
ES modules need a server; opening `index.html` as a file will not work.

## If friends can't connect
WebRTC tries a direct path using free Google STUN servers. Some strict networks (certain mobile carriers, corporate wifi) need a **TURN relay**. Add one without changing code:
`https://you.github.io/repo/?turn=turn:your.server:3478,username,password` (every player uses the same link). Free options: a small Coturn on any VPS, or a hosted TURN with a free tier. The matchmaking broker defaults to the free PeerJS cloud; you can self-host it (`npm i peer`) and point at it with `?peerHost=...&peerPort=...&peerPath=/&peerSecure=1`.

## How it works (the concepts)
| Idea | Where | In one line |
|---|---|---|
| Authoritative host | `js/host.js` | One browser owns the true state; others send *intents* and get back *views*. |
| Hidden information | `viewFor` in `js/engine.js` | The envelope and other hands are never sent to anyone. |
| Pure functions | `js/engine.js` | `state + action → new state`; no DOM, network or clock, so it is trivial to test. |
| State machine | `phase` in the engine | `start → move → suggest → refute → post`; illegal actions are rejected. |
| Graph + BFS | `reachable()` | Board tiles are nodes; BFS gives every square within N steps and the shortest path. |
| Fisher–Yates + seeded RNG | `shuffle`, `rand` | Fair shuffle; one integer of RNG state keeps games serialisable and replayable. |
| WebRTC signalling | `js/net.js` | A broker introduces browsers, then they talk directly. Room code = host's peer id. |
| Reconnect tokens | `join` in `js/host.js` | A secret per seat lets a refreshed tab take its seat back. |
| Render from state | `js/ui.js` | Board DOM is built once, then patched so tokens glide. Names are escaped (`esc`) against HTML injection. |

```
index.html            page shell, loads vendor/peerjs.min.js + js/main.js
js/data.js            cards, board grid, doors, passages, start tiles
js/engine.js          the rules (pure)
js/host.js            lobby + referee, transport-agnostic
js/net.js             PeerJS wrappers, heartbeat, reconnect
js/session.js         one interface for hotseat / host / client
js/ui.js, css/        everything visual
tests/                node:test suites
```

## House rules and honest limits
- Movement is "up to" the roll; entering a room ends it. Eliminated detectives do not block squares. A player with exactly one matching card shows it automatically.
- The board is my own layout in the classic style (9 rooms, 4 secret-passage rooms), not a pixel copy. Edit `js/data.js` to reshape it; the tests check doors and connectivity.
- Because the host's browser holds the envelope, a determined host could peek with dev tools. For friends that is an honour-system risk. To make it tamper-proof, run `engine.js` + `host.js` on a server (Node or a Cloudflare Durable Object): the same files work unchanged.
