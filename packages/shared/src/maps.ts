import { HOUSE_WALLS, MAP, SCATTERED_OBSTACLES, type Obstacle } from './constants.js';
import { FPS_SHOOTER_BOUNDS, FPS_SHOOTER_OBSTACLES } from './maps/fps_shooter.collision.js';
import { FPS_SHOOTER_TRIS, type CollisionTri } from './maps/fps_shooter.mesh.js';
import type { Vec3 } from './state.js';

export type MapId = 'fps_shooter' | 'arena';

export interface MapDef {
  readonly id: MapId;
  readonly displayName: string;
  // Side length of the perimeter clamp box (the runtime treats this as a
  // square arena centered on the origin).
  readonly size: number;
  // Half-width of the safe random-spawn box; smaller than `size / 2` so
  // players don't spawn inside a perimeter wall.
  readonly spawnArea: number;
  readonly spawnHeight: number;
  readonly obstacles: readonly Obstacle[];
  // Precise triangle mesh used for shot raycasts when present. Movement
  // collision still uses `obstacles` (AABBs) — capsule-vs-mesh resolution is
  // a follow-up. Maps without a baked mesh leave this empty and shots fall
  // back to the AABB raycast path.
  readonly collisionTris: readonly CollisionTri[];
  // Hand-authored or grid-generated nav graph used by bot pathfinding.
  readonly waypoints: readonly Vec3[];
  readonly edges: readonly (readonly [number, number])[];
  // Translation applied to a GLTF-rendered scene so its origin matches the
  // collision data. null for procedural maps with no GLTF.
  readonly gltfOffset: readonly [number, number, number] | null;
}

const ARENA_WAYPOINTS: readonly Vec3[] = [
  [-3, MAP.spawnHeight, 3],
  [3, MAP.spawnHeight, 3],
  [-3, MAP.spawnHeight, -3],
  [3, MAP.spawnHeight, -3],
  [-3, MAP.spawnHeight, -7.5],
  [-3, MAP.spawnHeight, 0],
  [3, MAP.spawnHeight, 0],
  [0, MAP.spawnHeight, 3],
  [0, MAP.spawnHeight, -3],
  [-10, MAP.spawnHeight, 9],
  [10, MAP.spawnHeight, 9],
  [10, MAP.spawnHeight, -9],
  [-10, MAP.spawnHeight, -9],
  [-15, MAP.spawnHeight, -4],
  [13, MAP.spawnHeight, -5],
  [2, MAP.spawnHeight, 16],
];

const ARENA_EDGES: readonly (readonly [number, number])[] = [
  [0, 5], [2, 5],
  [1, 6], [3, 6],
  [0, 7], [1, 7],
  [2, 8], [3, 8],
  [2, 4],
  [4, 12], [4, 11],
  [9, 10], [10, 11], [11, 12], [12, 9],
  [12, 13], [9, 15], [10, 15], [11, 14],
  [4, 13], [4, 14],
];

// Auto-generate a roaming grid for a map: drop nodes inside the playable
// box, skip ones that intersect the supplied obstacle list, then connect
// each node to its 8 grid neighbors when both endpoints have line-of-sight.
const buildGrid = (
  obstacles: readonly Obstacle[],
  half: number,
  step: number,
  y: number,
): { waypoints: Vec3[]; edges: [number, number][] } => {
  const cells: Array<{ x: number; z: number }> = [];
  const cols = Math.floor((half * 2) / step) + 1;
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -half + c * step;
      const z = -half + r * step;
      cells.push({ x, z });
    }
  }

  const insideObstacle = (x: number, z: number): boolean => {
    for (const o of obstacles) {
      if (
        x > o.pos[0] - o.halfSize[0] - 0.4 &&
        x < o.pos[0] + o.halfSize[0] + 0.4 &&
        y > o.pos[1] - o.halfSize[1] - 0.9 &&
        y < o.pos[1] + o.halfSize[1] + 0.9 &&
        z > o.pos[2] - o.halfSize[2] - 0.4 &&
        z < o.pos[2] + o.halfSize[2] + 0.4
      ) {
        return true;
      }
    }
    return false;
  };

  const segmentBlocked = (a: Vec3, b: Vec3): boolean => {
    const samples = 8;
    for (let s = 1; s < samples; s++) {
      const t = s / samples;
      const x = a[0] + (b[0] - a[0]) * t;
      const yy = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      if (insideObstacle(x, z)) return true;
      // Check the eye height too (rough LOS for tall walls).
      if (insideObstacle(x, z) || pointBlockedAtY(x, yy, z, obstacles)) return true;
    }
    return false;
  };

  const indexOfCell: number[] = [];
  const waypoints: Vec3[] = [];
  for (const cell of cells) {
    if (insideObstacle(cell.x, cell.z)) {
      indexOfCell.push(-1);
      continue;
    }
    indexOfCell.push(waypoints.length);
    waypoints.push([cell.x, y, cell.z]);
  }

  const edges: [number, number][] = [];
  const cellAt = (r: number, c: number): number => {
    if (r < 0 || c < 0 || r >= cols || c >= cols) return -1;
    return indexOfCell[r * cols + c] ?? -1;
  };
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const a = cellAt(r, c);
      if (a < 0) continue;
      const neighbors = [
        cellAt(r, c + 1),
        cellAt(r + 1, c),
        cellAt(r + 1, c + 1),
        cellAt(r + 1, c - 1),
      ];
      for (const b of neighbors) {
        if (b < 0) continue;
        if (segmentBlocked(waypoints[a]!, waypoints[b]!)) continue;
        edges.push([a, b]);
      }
    }
  }
  return { waypoints, edges };
};

const pointBlockedAtY = (
  x: number,
  y: number,
  z: number,
  obstacles: readonly Obstacle[],
): boolean => {
  for (const o of obstacles) {
    if (
      x > o.pos[0] - o.halfSize[0] &&
      x < o.pos[0] + o.halfSize[0] &&
      y > o.pos[1] - o.halfSize[1] &&
      y < o.pos[1] + o.halfSize[1] &&
      z > o.pos[2] - o.halfSize[2] &&
      z < o.pos[2] + o.halfSize[2]
    ) {
      return true;
    }
  }
  return false;
};

// Bot waypoints sit at the player's standing height on top of the floor
// slab (floor top ≈0.5 m + half-capsule 0.9 ≈ 1.4 m). Going lower would
// put every waypoint inside the floor AABB and the grid would come back
// empty.
const FPS_SHOOTER_GRID = buildGrid(
  FPS_SHOOTER_OBSTACLES,
  Math.max(FPS_SHOOTER_BOUNDS.sizeX, FPS_SHOOTER_BOUNDS.sizeZ) / 2 - 2,
  3,
  1.5,
);

export const MAPS: Record<MapId, MapDef> = {
  fps_shooter: {
    id: 'fps_shooter',
    displayName: 'FPS Shooter Arena',
    size: Math.max(FPS_SHOOTER_BOUNDS.sizeX, FPS_SHOOTER_BOUNDS.sizeZ),
    spawnArea: Math.max(FPS_SHOOTER_BOUNDS.sizeX, FPS_SHOOTER_BOUNDS.sizeZ) / 2 - 3,
    // Spawn above the GLTF floor (top y≈0.5 at 1× scale) — gravity drops
    // the player onto whichever surface is below them. The static
    // floor=halfH clamp in sim.ts is just a safety net; the floor slab in
    // FPS_SHOOTER_OBSTACLES is what actually stops the fall.
    spawnHeight: 4,
    obstacles: FPS_SHOOTER_OBSTACLES,
    collisionTris: FPS_SHOOTER_TRIS,
    waypoints: FPS_SHOOTER_GRID.waypoints,
    edges: FPS_SHOOTER_GRID.edges,
    gltfOffset: [
      FPS_SHOOTER_BOUNDS.offsetX,
      FPS_SHOOTER_BOUNDS.offsetY,
      FPS_SHOOTER_BOUNDS.offsetZ,
    ],
  },
  arena: {
    id: 'arena',
    displayName: 'Original Arena',
    size: MAP.size,
    spawnArea: MAP.size / 2 - 4,
    spawnHeight: MAP.spawnHeight,
    obstacles: [...HOUSE_WALLS, ...SCATTERED_OBSTACLES],
    collisionTris: [],
    waypoints: ARENA_WAYPOINTS,
    edges: ARENA_EDGES,
    gltfOffset: null,
  },
};

export const DEFAULT_MAP_ID: MapId = 'fps_shooter';

export const isMapId = (v: string | null | undefined): v is MapId =>
  v === 'fps_shooter' || v === 'arena';

let active: MapDef = MAPS[DEFAULT_MAP_ID];

export const setActiveMap = (id: MapId): void => {
  active = MAPS[id];
};

export const getActiveMap = (): MapDef => active;
