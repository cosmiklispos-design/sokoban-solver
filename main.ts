// Sokoban push-optimal solver — entry for make.fun's
// "Build the best Sokoban solver, 21 November 2026"
// (https://make.fun/bounty/sokoban-solver-01-run-20261121).
//
// How it works
// ------------
// The levels this bounty draws are built from independent rooms off a
// one-square hallway: every box stays in its room, and the level's
// push-optimal count P* is the sum of its rooms' optima. So this program
// solves each room on its own, in turn, and stitches the moves together
// (the player walks on from where the last room left it). That turns one
// 16-box search into four 4-box searches.
//
// Each room is solved by an A* over pushes, not moves: a state is the
// boxes' squares plus the player's reachable region (named by its lowest
// square — where the player stands inside the region does not matter for
// the next push). The heuristic is the cheapest matching of boxes to
// goals over floor distances (admissible: one push moves one box one
// square), so the first solved state popped is push-optimal. Two
// deadlocks are pruned, and neither prunes a solvable state:
//   - a box on a dead square (no push, ignoring the other boxes, can ever
//     bring it to a goal), found by pulling boxes back from the goals;
//   - a box in a frozen 2x2 block of walls and boxes with a box off goal.
// If a level does not split into rooms, the same push A* runs on the
// whole level, and as a last resort a move-based A* (also deadlock-aware)
// finds any solution, even a non-optimal one — a solved level scores
// far more than an unsolved one.
//
// Determinism: every budget is counted in expanded states, never in
// wall-clock time, and every tie is broken by insertion order, so two
// runs write the same bytes. The program reads no clock and no
// randomness. It never throws for one bad instance: a level it cannot
// solve still gets a (valid, empty) solution.txt, so every instance is
// answered in the stated format.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Budgets counted in expanded states (work, not time — see the header).
const ROOM_CAP = 250_000;
const WHOLE_CAP = 500_000;
const MOVE_CAP = 500_000;
const GLOBAL_CAP = 2_000_000;

// The four steps: [dx, dy, walk letter, push letter].
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// ---------------------------------------------------------------- parsing

function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ------------------------------------------------------- board primitives

// Squares from which a box can still be pushed onto some goal, ignoring
// the other boxes: start at the goals and pull boxes back (a box at x
// could have come from y = x - d when y and the player's square y - d
// are both open floor).
function liveSquares(level) {
  const { w, h, wall, goals } = level;
  const live = new Uint8Array(w * h);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    const xx = x % w;
    const xy = Math.floor(x / w);
    for (const [dx, dy] of DIRS) {
      const yx = xx - dx;
      const yy = xy - dy;
      const px = xx - 2 * dx;
      const py = xy - 2 * dy;
      if (yx < 0 || yy < 0 || yx >= w || yy >= h) continue;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const y = yy * w + yx;
      const p = py * w + px;
      if (!wall[y] && !wall[p] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Floor distances from one square, ignoring boxes (BFS). -1: unreachable.
function distancesFrom(level, from) {
  const { w, h, wall } = level;
  const dist = new Int32Array(w * h).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    const px = p % w;
    const py = Math.floor(p / w);
    for (const [dx, dy] of DIRS) {
      const qx = px + dx;
      const qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx;
      if (wall[q] || dist[q] !== -1) continue;
      dist[q] = dist[p] + 1;
      queue.push(q);
    }
  }
  return dist;
}

// The squares the player reaches from `from` with `occupied` in the way;
// marks them in `seen` with `stamp` and returns the lowest such square
// (the region's name: any square of the region reaches the same pushes).
function reach(level, occupied, from, seen, stamp, stack) {
  const { w, h, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const px = p % w;
    const py = Math.floor(p / w);
    for (const [dx, dy] of DIRS) {
      const qx = px + dx;
      const qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block: four
// squares of walls and boxes, with a box among them off its goal.
function frozenBlock(level, occupied, goal, t) {
  const { w, h, wall } = level;
  const tx = t % w;
  const ty = Math.floor(t / w);
  for (const [ax, ay] of [[tx - 1, ty - 1], [tx, ty - 1], [tx - 1, ty], [tx, ty]]) {
    if (ax < 0 || ay < 0 || ax + 1 >= w || ay + 1 >= h) continue;
    const a = ay * w + ax;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) ||
        (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// LURD letters (direction order u, d, l, r breaks ties, deterministically).
function walkTo(level, occupied, from, to) {
  const { w, h, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const how = new Array(w * h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    const px = p % w;
    const py = Math.floor(p / w);
    for (const [dx, dy, letter] of DIRS) {
      const qx = px + dx;
      const qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walk unreachable');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

// The player's square after playing `moves` from `from`.
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

// ------------------------------------------------------------------- heap

// A binary heap ordered by (f, h, sequence): a total order, so the
// search is deterministic.
function heapPush(heap, e) {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i], heap[p])) break;
    const t = heap[i]; heap[i] = heap[p]; heap[p] = t;
    i = p;
  }
}
function heapLess(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}
function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
      if (!heapLess(heap[c], heap[i])) break;
      const t = heap[i]; heap[i] = heap[c]; heap[c] = t;
      i = c;
    }
  }
  return top;
}

// ------------------------------------------------------------ push search

// A* over pushes for one (sub)level: { pushes, moves }, or null when the
// search gives up (state cap, work budget, or no solution). The first
// solved state popped is push-optimal: the heuristic below is admissible
// and consistent, and states expand in nondecreasing f. `stopAt` caps
// this call's share of the shared work budget, so a caller can reserve
// work for its fallbacks.
function pushSearch(level, maxStates, budget, stopAt = budget.limit) {
  const { w, h, wall, goals } = level;
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  // Floor distances from each goal, for the heuristic.
  const dists = goals.map((g) => distancesFrom(level, g));
  const n = level.boxes.length;
  // Cheapest box-to-goal matching (exact for few boxes, sum-of-minimums
  // past that — both admissible). Infinity means no assignment exists.
  const heuristic = (boxes) => {
    if (n <= 5) {
      let best = Infinity;
      const used = new Array(goals.length).fill(false);
      const rec = (i, sum) => {
        if (sum >= best) return;
        if (i === n) { best = sum; return; }
        for (let g = 0; g < goals.length; g++) {
          if (used[g]) continue;
          const d = dists[g][boxes[i]];
          if (d < 0) continue;
          used[g] = true;
          rec(i + 1, sum + d);
          used[g] = false;
        }
      };
      rec(0, 0);
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let g = 0; g < goals.length; g++) {
        const d = dists[g][b];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  const numericKey = size ** (n + 1) < 2 ** 53;
  const keyOf = numericKey
    ? (boxes, low) => { let k = low; for (const b of boxes) k = k * size + b; return k; }
    : (boxes, low) => low + '|' + boxes.join(',');

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes) => boxes.every((b) => goal[b]);

  const sBoxes = [level.boxes.slice()];
  const sPlayer = [level.player];
  const sParent = [-1];
  const sFrom = [-1];
  const sTo = [-1];
  const sDir = [-1];
  const sG = [0];
  const bestG = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  // Each state's region, named by its lowest square, fixed at insertion:
  // the region is part of the state (the same boxes with the player in a
  // different region allow different pushes), so the key must carry it.
  const sLow = [startLow];
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;
  bestG.set(keyOf(level.boxes, startLow), 0);
  let seq = 0;
  const heap = [];
  heapPush(heap, [h0, h0, seq++, 0]);
  const expanded = new Set();
  let found = solved(level.boxes) ? 0 : -1;

  while (heap.length > 0 && found < 0) {
    const [, , , s] = heapPop(heap);
    const boxes = sBoxes[s];
    const k = keyOf(boxes, sLow[s]);
    if (expanded.has(k)) continue;
    expanded.add(k);
    if (budget.used >= stopAt || expanded.size > maxStates) return null;
    budget.used++;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, sPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      const bxx = b % w;
      const bxy = Math.floor(b / w);
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const sx = bxx - dx;
        const sy = bxy - dy;
        const tx = bxx + dx;
        const ty = bxy + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const stance = sy * w + sx;
        const t = ty * w + tx;
        if (seen[stance] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = null;
        let next = null;
        let hn = Infinity;
        let childLow = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          hn = heuristic(next);
          if (hn !== Infinity) {
            childLow = reach(level, occupied, b, mark, ++stamp, stack);
            key = keyOf(next, childLow);
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || key === null) continue;
        const g = sG[s] + 1;
        const known = bestG.get(key);
        if (known !== undefined && known <= g) continue;
        if (sBoxes.length >= maxStates) return null;
        bestG.set(key, g);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sLow.push(childLow);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(di);
        sG.push(g);
        if (solved(next)) { found = idx; break; }
        heapPush(heap, [g + hn, hn, seq++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's stance square, then push.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  try {
    for (const s of path) {
      const nextBoxes = sBoxes[s];
      const from = sFrom[s];
      const to = sTo[s];
      const d = to - from;
      const dir = DIRS[sDir[s]];
      if (!dir || dir[0] * 1 + dir[1] * w !== d) throw new Error('bad push');
      for (const b of boxes) occupied[b] = 1;
      moves += walkTo(level, occupied, player, from - d);
      for (const b of boxes) occupied[b] = 0;
      moves += dir[3];
      player = from;
      boxes = nextBoxes;
    }
  } catch {
    return null;
  }
  return { pushes: path.length, moves };
}

// ------------------------------------------------------------- move search

// Last-resort solver: A* over moves (walks cost 1, pushes cost 1) with
// the same admissible heuristic, pruning pushes onto dead squares. It
// finds a solution whenever the push search cannot, at the price of
// possibly extra pushes — a solved level still scores.
function moveSearch(level, maxStates, budget, stopAt = budget.limit) {
  const { w, h, wall, goals } = level;
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const dists = goals.map((g) => distancesFrom(level, g));
  const heuristic = (boxes) => {
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let g = 0; g < goals.length; g++) {
        const d = dists[g][b];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };
  const keyOf = (p, boxes) => p + '|' + boxes.join(',');

  const sP = [level.player];
  const sB = [level.boxes.slice()];
  const sParent = [-1];
  const sStep = [''];
  const sG = [0];
  const bestG = new Map([[keyOf(level.player, level.boxes), 0]]);
  let seq = 0;
  const heap = [];
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;
  heapPush(heap, [h0, h0, seq++, 0]);
  const expanded = new Set();
  let found = level.boxes.every((b) => goal[b]) ? 0 : -1;

  while (heap.length > 0 && found < 0) {
    const [, , , s] = heapPop(heap);
    const p = sP[s];
    const boxes = sB[s];
    const k = keyOf(p, boxes);
    if (expanded.has(k)) continue;
    expanded.add(k);
    if (budget.used >= stopAt || expanded.size > maxStates) return null;
    budget.used++;
    const px = p % w;
    const py = Math.floor(p / w);
    for (let di = 0; di < 4; di++) {
      const [dx, dy, letter] = DIRS[di];
      const qx = px + dx;
      const qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx;
      if (wall[q]) continue;
      let nb = boxes;
      let step = letter;
      const at = boxes.indexOf(q);
      if (at >= 0) {
        const tx = qx + dx;
        const ty = qy + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const t = ty * w + tx;
        if (wall[t] || boxes.includes(t) || !live[t]) continue;
        nb = boxes.slice();
        nb[at] = t;
        nb.sort((a, b) => a - b);
        step = letter.toUpperCase();
      }
      const g = sG[s] + 1;
      const kk = keyOf(q, nb);
      const known = bestG.get(kk);
      if (known !== undefined && known <= g) continue;
      if (sB.length >= maxStates) return null;
      bestG.set(kk, g);
      const idx = sB.length;
      sP.push(q);
      sB.push(nb);
      sParent.push(s);
      sStep.push(step);
      sG.push(g);
      if (nb.every((b) => goal[b])) { found = idx; break; }
      const hn = heuristic(nb);
      if (hn === Infinity) continue;
      heapPush(heap, [g + hn, hn, seq++, idx]);
    }
  }
  if (found < 0) return null;
  let moves = '';
  for (let s = found; s > 0; s = sParent[s]) moves = sStep[s] + moves;
  return { pushes: -1, moves };
}

// ------------------------------------------------------- room decomposition

// Split a level into rooms: cut the hallway row's dead squares (floor
// the player walks, where a box reaches no goal) out of the floor, and
// each remaining part holding a box is a room. Null when the level is
// no set of rooms (a box in the hallway, a goal outside every room, or
// a room whose boxes and goals do not match).
function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(w * h).fill(-1);
  const rooms = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      const px = p % w;
      const py = Math.floor(p / w);
      for (const [dx, dy] of DIRS) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve one room order: each room in turn, the other rooms' boxes
// standing as walls (on their goals once their room is done), the player
// walking on from where the last room left it. Null when any room's
// search gives up.
function tryRooms(level, rooms, order, budget, stopAt) {
  const current = rooms.map((r) => r.boxes.slice().sort((a, b) => a - b));
  let player = level.player;
  let moves = '';
  let pushes = 0;
  for (const ri of order) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    rooms.forEach((other, oi) => {
      if (oi === ri) return;
      for (const b of current[oi]) wall[b] = 1;
    });
    const sub = {
      w: level.w, h: level.h, wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: current[ri].slice(), player,
    };
    const solved = pushSearch(sub, ROOM_CAP, budget, stopAt);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    current[ri] = room.goals.slice().sort((a, b) => a - b);
  }
  return { pushes, moves };
}

// Orders to try: scan order, reversed, and nearest room first (by the
// room's closest square to the player). Solving one room can leave the
// player inside it, so the order matters when a solved room's exit is
// blocked — a different order may leave that room for last.
function roomOrders(rooms, level) {
  const scan = rooms.map((_, i) => i);
  const reversed = [...scan].reverse();
  const px = level.player % level.w;
  const py = Math.floor(level.player / level.w);
  const nearest = [...scan].sort((a, b) => {
    const da = Math.min(...rooms[a].squares.map((s) => Math.abs((s % level.w) - px) + Math.abs(Math.floor(s / level.w) - py)));
    const db = Math.min(...rooms[b].squares.map((s) => Math.abs((s % level.w) - px) + Math.abs(Math.floor(s / level.w) - py)));
    return da - db || a - b;
  });
  const orders = [scan, reversed, nearest];
  return orders.filter((o, i) => orders.findIndex((p) => p.join() === o.join()) === i);
}

// ------------------------------------------------------------------- driver

function solveLevel(level) {
  try {
    const goal = new Set(level.goals);
    if (level.boxes.every((b) => goal.has(b))) return '';
    const budget = { used: 0, limit: GLOBAL_CAP };
    // Work is phased so the fallbacks always keep a share: rooms may
    // spend up to 1.2M expansions, the whole-level search up to 1.6M,
    // the move search the rest.
    const rooms = roomsOf(level);
    if (rooms !== null) {
      for (const order of roomOrders(rooms, level)) {
        const r = tryRooms(level, rooms, order, budget, 1_200_000);
        if (r !== null) return r.moves;
        if (budget.used >= 1_200_000) break;
      }
    }
    if (budget.used < 1_600_000) {
      const whole = pushSearch(level, WHOLE_CAP, budget, 1_600_000);
      if (whole !== null) return whole.moves;
    }
    if (budget.used < budget.limit) {
      const mv = moveSearch(level, MOVE_CAP, budget);
      if (mv !== null) return mv.moves;
    }
    return '';
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
