// data.js — all the static facts about the game: cards, board, doors, passages.
//
// CONCEPT: the board is a *graph*. Every walkable hallway tile is a node and
// neighbouring tiles are edges. Each room is ONE node (pieces inside a room have
// no exact tile), connected to the hallway through "doorstep" tiles. Secret
// passages are just two extra edges between room nodes. Movement is then a
// breadth-first search over this graph (see engine.js).

export const SUSPECTS = [
  { id: 'scarlett', name: 'Miss Scarlett',    short: 'Sc', color: '#b3262e', start: [16, 0] },
  { id: 'mustard',  name: 'Colonel Mustard',  short: 'Mu', color: '#d9a21b', start: [23, 7] },
  { id: 'white',    name: 'Mrs. White',       short: 'Wh', color: '#e9e6dc', start: [16, 24] },
  { id: 'green',    name: 'Reverend Green',   short: 'Gr', color: '#2f7d4f', start: [7, 24] },
  { id: 'peacock',  name: 'Mrs. Peacock',     short: 'Pe', color: '#2b5fa8', start: [0, 18] },
  { id: 'plum',     name: 'Professor Plum',   short: 'Pl', color: '#6d3a86', start: [0, 5] },
];

export const WEAPONS = [
  { id: 'candlestick', name: 'Candlestick', icon: '🕯️' },
  { id: 'dagger',      name: 'Dagger',      icon: '🗡️' },
  { id: 'leadpipe',    name: 'Lead Pipe',   icon: '🔩' },
  { id: 'revolver',    name: 'Revolver',    icon: '🔫' },
  { id: 'rope',        name: 'Rope',        icon: '🪢' },
  { id: 'wrench',      name: 'Wrench',      icon: '🔧' },
];

// Room rectangles on the 24 x 25 grid: x, y, width, height.
export const ROOMS = [
  { id: 'study',        name: 'Study',        rect: [0, 0, 7, 4] },
  { id: 'hall',         name: 'Hall',         rect: [9, 0, 6, 7] },
  { id: 'lounge',       name: 'Lounge',       rect: [17, 0, 7, 6] },
  { id: 'library',      name: 'Library',      rect: [0, 7, 6, 4] },
  { id: 'dining',       name: 'Dining Room',  rect: [16, 8, 8, 6] },
  { id: 'billiard',     name: 'Billiard Room',rect: [0, 13, 6, 5] },
  { id: 'conservatory', name: 'Conservatory', rect: [0, 20, 6, 5] },
  { id: 'ballroom',     name: 'Ballroom',     rect: [8, 17, 8, 8] },
  { id: 'kitchen',      name: 'Kitchen',      rect: [18, 19, 6, 6] },
];

// The centre block where the envelope lives. Nobody can enter it.
export const CELLAR = { name: 'The Envelope', rect: [10, 9, 4, 6] };

export const COLS = 24;
export const ROWS = 25;

// Tiles nobody can stand on (little "furniture" blocks that shape the corridors).
export const VOID_RECTS = [
  [7, 0, 2, 3],   // between Study and Hall
  [6, 23, 1, 2],  // bottom, between Conservatory and Ballroom (Green starts just beside it)
  [21, 6, 3, 1],  // tuck under the Lounge
];

// A door is the hallway tile directly outside a room ("doorstep").
// Standing on it lets you step into the room with one more move.
export const DOORS = {
  study:        [[4, 4]],
  hall:         [[11, 7], [12, 7], [8, 4]],
  lounge:       [[18, 6]],
  library:      [[6, 9], [3, 6]],
  dining:       [[15, 10], [17, 7]],
  billiard:     [[6, 15], [2, 12]],
  conservatory: [[3, 19], [6, 21]],
  ballroom:     [[9, 16], [14, 16], [7, 19], [16, 19]],
  kitchen:      [[18, 18]],
};

// Secret passages: corner room <-> opposite corner room (extra graph edges).
export const PASSAGES = {
  study: 'kitchen',
  kitchen: 'study',
  lounge: 'conservatory',
  conservatory: 'lounge',
};

// ---- derived lookups (built once) -------------------------------------------

export const SUSPECT_IDS = SUSPECTS.map(s => s.id);
export const WEAPON_IDS = WEAPONS.map(w => w.id);
export const ROOM_IDS = ROOMS.map(r => r.id);
export const ALL_CARDS = [...SUSPECT_IDS, ...WEAPON_IDS, ...ROOM_IDS];

export const suspectById = Object.fromEntries(SUSPECTS.map(s => [s.id, s]));
export const weaponById = Object.fromEntries(WEAPONS.map(w => [w.id, w]));
export const roomById = Object.fromEntries(ROOMS.map(r => [r.id, r]));

export function cardType(id) {
  if (suspectById[id]) return 'suspect';
  if (weaponById[id]) return 'weapon';
  if (roomById[id]) return 'room';
  return null;
}
export function cardName(id) {
  return (suspectById[id] || weaponById[id] || roomById[id] || { name: id }).name;
}

const inRect = (x, y, [rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;

// grid[y][x] -> 'hallway' | 'void' | 'cellar' | roomId   (NB: 'hall' is a ROOM id, so hallway tiles must not reuse that word)
export const GRID = (() => {
  const g = [];
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) {
      let t = 'hallway';
      if (VOID_RECTS.some(r => inRect(x, y, r))) t = 'void';
      if (inRect(x, y, CELLAR.rect)) t = 'cellar';
      for (const r of ROOMS) if (inRect(x, y, r.rect)) t = r.id;
      row.push(t);
    }
    g.push(row);
  }
  return g;
})();

export const isHall = (x, y) => y >= 0 && y < ROWS && x >= 0 && x < COLS && GRID[y][x] === 'hallway';

// doorstep tile "x,y" -> room id
export const DOORSTEP_TO_ROOM = (() => {
  const m = {};
  for (const [room, list] of Object.entries(DOORS)) for (const [x, y] of list) m[`${x},${y}`] = room;
  return m;
})();
