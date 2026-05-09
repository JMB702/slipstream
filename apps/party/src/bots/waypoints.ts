import { MAP, raycastObstacles, type Vec3 } from '@slipstream/shared';

// Hand-authored navigation graph. Nodes cover:
//   - 4 room interior centers (NW/NE/SW/SE)
//   - Front door (south, x=-3)
//   - 3 interior doorway pinch points (NW↔SW at x=-3,z=0; NE↔SE at x=+3,z=0;
//     NW↔NE at x=0,z=+3; SW↔SE at x=0,z=-3)
//   - 4 exterior corners just outside the house corners
//   - 2 outer-cover nodes near scattered obstacles
//
// Coordinates use the standard right-handed system (per CLAUDE.md and
// constants.ts): +x right, +z south, -z north. House half-extent is 6m.
//
// Y is fixed at floor height — we plan in 2D, gravity handles the rest.
const Y = MAP.spawnHeight;

const node = (x: number, z: number): Vec3 => [x, Y, z];

export const WAYPOINTS: readonly Vec3[] = [
  // 0 NW room center
  node(-3, 3),
  // 1 NE room center
  node(3, 3),
  // 2 SW room center
  node(-3, -3),
  // 3 SE room center
  node(3, -3),
  // 4 Front door (south wall, x=-3, just outside)
  node(-3, -7.5),
  // 5 NW↔SW interior doorway (x=-3, z=0)
  node(-3, 0),
  // 6 NE↔SE interior doorway (x=+3, z=0)
  node(3, 0),
  // 7 NW↔NE interior doorway (x=0, z=+3)
  node(0, 3),
  // 8 SW↔SE interior doorway (x=0, z=-3)
  node(0, -3),
  // 9 Exterior NW corner
  node(-10, 9),
  // 10 Exterior NE corner
  node(10, 9),
  // 11 Exterior SE corner
  node(10, -9),
  // 12 Exterior SW corner
  node(-10, -9),
  // 13 Outer cover near scattered box at (-12, ?, -8)
  node(-15, -4),
  // 14 Outer cover near scattered box at (10, ?, -10)
  node(13, -5),
  // 15 Outer cover near scattered box at (6, ?, 14)
  node(2, 16),
];

// Edges hand-listed. Bidirectional. Pairs the graph keeps logical without
// random shortcuts that would bypass the house's interior structure.
const EDGE_LIST: readonly (readonly [number, number])[] = [
  // Interior connectivity through doorways
  [0, 5], [2, 5],          // NW <-> NW/SW doorway <-> SW
  [1, 6], [3, 6],          // NE <-> NE/SE doorway <-> SE
  [0, 7], [1, 7],          // NW <-> NW/NE doorway <-> NE
  [2, 8], [3, 8],          // SW <-> SW/SE doorway <-> SE
  // Front door from SW room to outside-front
  [2, 4],
  // Exterior ring around the house
  [4, 12], [4, 11],        // front door to outside corners
  [9, 10], [10, 11], [11, 12], [12, 9],
  // Exterior corners to the cover nodes near them
  [12, 13], [9, 15], [10, 15], [11, 14],
  // A direct exterior link from front door to nearby cover so SW spawns
  // have a fast outdoor option.
  [4, 13], [4, 14],
];

export interface NavGraph {
  readonly nodes: readonly Vec3[];
  // Adjacency list: adj[i] = neighbor indices reachable from i.
  readonly adj: readonly (readonly number[])[];
  // Edge cost cache: cost[i][j] = euclidean distance, or Infinity if no edge.
  readonly cost: readonly (readonly number[])[];
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const buildGraph = (): NavGraph => {
  const n = WAYPOINTS.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  const cost: number[][] = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (const [a, b] of EDGE_LIST) {
    if (a === b) continue;
    if (!adj[a]!.includes(b)) adj[a]!.push(b);
    if (!adj[b]!.includes(a)) adj[b]!.push(a);
    const d = dist3(WAYPOINTS[a]!, WAYPOINTS[b]!);
    cost[a]![b] = d;
    cost[b]![a] = d;
  }
  return { nodes: WAYPOINTS, adj, cost };
};

export const NAV_GRAPH: NavGraph = buildGraph();

// Pick the closest node to `pos` whose straight-line connection to `pos` is
// not blocked by an obstacle. Falls back to the absolute-closest node if no
// unobstructed candidate exists (covers degenerate spawn-inside-cover cases).
export const nearestReachableNode = (pos: Vec3): number => {
  let bestIdx = 0;
  let bestDist = Infinity;
  let bestVisibleIdx = -1;
  let bestVisibleDist = Infinity;
  for (let i = 0; i < NAV_GRAPH.nodes.length; i++) {
    const node = NAV_GRAPH.nodes[i]!;
    const d = dist3(pos, node);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
    if (hasLineOfSight(pos, node)) {
      if (d < bestVisibleDist) {
        bestVisibleDist = d;
        bestVisibleIdx = i;
      }
    }
  }
  return bestVisibleIdx >= 0 ? bestVisibleIdx : bestIdx;
};

// Cheap LOS check between two positions: ray from a to b, see if any obstacle
// lies on the segment. Used by the bot controller for "can I see my target"
// and for graph nearest-node selection.
export const hasLineOfSight = (a: Vec3, b: Vec3): boolean => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-4) return true;
  const dir: Vec3 = [dx / len, dy / len, dz / len];
  const t = raycastObstacles(a, dir, len);
  return t === null;
};

