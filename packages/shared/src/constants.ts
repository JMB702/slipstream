export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;

export const MAX_PLAYERS = 8;

export const MAP = {
  size: 60,
  // Y-coordinate of the capsule center at spawn = ground-rest height (height/2).
  // Spawning above floor would cause idle players to float forever, since the
  // server only integrates gravity when an input arrives.
  spawnHeight: 0.9,
} as const;

export const PLAYER = {
  radius: 0.4,
  height: 1.8,
  walkSpeed: 6.0,
  sprintSpeed: 9.0,
  jumpSpeed: 7.0,
  gravity: 22.0,
  maxHealth: 100,
  respawnMs: 3000,
} as const;

export const WEAPON = {
  damage: 25,
  fireIntervalMs: 120,
  magazineSize: 30,
  reloadMs: 1500,
  range: 80,
  spreadDeg: 1.5,
} as const;

export const NET = {
  interpolationDelayMs: 100,
  inputBufferMax: 60,
} as const;

export interface Obstacle {
  // World-space center of the box.
  readonly pos: readonly [number, number, number];
  // Half-extents (full size = 2 * half on each axis).
  readonly halfSize: readonly [number, number, number];
}

// Loose obstacles scattered around the map outside the house.
export const SCATTERED_OBSTACLES: readonly Obstacle[] = [
  { pos: [-12, 1, -8], halfSize: [2, 1, 2] },
  { pos: [10, 1, -10], halfSize: [1.5, 1, 3] },
  { pos: [-15, 0.5, 12], halfSize: [4, 0.5, 1.5] },
  { pos: [14, 2, 8], halfSize: [1.5, 2, 1.5] },
  { pos: [6, 1, 14], halfSize: [2, 1, 2] },
  { pos: [-6, 0.75, -16], halfSize: [3, 0.75, 1] },
];

// 4-room house centered at origin. Each wall is split into the AABBs that
// frame doors and windows, so the gaps you see in the geometry ARE the
// openings — collision and rendering use the same list.
//
// Layout (top-down, +x right, +z south, -z north — standard right-handed):
//   - 12×12 footprint, walls 3m tall and 0.3m thick
//   - Interior walls at x=0 and z=0 partition into NW/NE/SW/SE rooms
//   - Front door on south wall, offset to x=-3 so it enters the SW room
//     directly without colliding with the central interior wall
//   - Windows on north (x=+3), east (z=-3), west (z=+3) walls so each
//     non-front room has a view outside
//   - Doorway between every adjacent pair of rooms (4 interior doorways:
//     SW↔NW, NW↔NE, NE↔SE, SW↔SE)
//   - Flat roof slab on top
const HOUSE_W = 6;
const WALL_T = 0.15;
const WALL_H = 1.5;
const WALL_TOP_Y = WALL_H * 2;
const DOOR_HW = 0.8;
const DOOR_TOP = 2.2;
const DOOR_HEADER_HALF_H = (WALL_TOP_Y - DOOR_TOP) / 2;
const DOOR_HEADER_Y = (WALL_TOP_Y + DOOR_TOP) / 2;
const WIN_HW = 0.75;
const WIN_BOTTOM = 1.0;
const WIN_TOP = 2.0;
const WIN_SILL_HALF_H = WIN_BOTTOM / 2;
const WIN_SILL_Y = WIN_BOTTOM / 2;
const WIN_HEADER_HALF_H = (WALL_TOP_Y - WIN_TOP) / 2;
const WIN_HEADER_Y = (WALL_TOP_Y + WIN_TOP) / 2;

// Helper: an axis-aligned wall slab spanning [a, b] on the in-wall axis,
// at fixed y from 0..WALL_TOP_Y, sitting at constant `fixed` on the through-axis.
// `axis` is which axis the wall RUNS along (the slab's length axis).
const wallSegment = (
  axis: 'x' | 'z',
  fixed: number, // value on the through-axis
  a: number,
  b: number,
  yCenter = WALL_H,
  yHalf = WALL_H,
): Obstacle => {
  const center = (a + b) / 2;
  const half = Math.abs(b - a) / 2;
  return axis === 'x'
    ? { pos: [center, yCenter, fixed], halfSize: [half, yHalf, WALL_T] }
    : { pos: [fixed, yCenter, center], halfSize: [WALL_T, yHalf, half] };
};

const doorHeader = (axis: 'x' | 'z', fixed: number, doorCenter: number): Obstacle =>
  axis === 'x'
    ? {
        pos: [doorCenter, DOOR_HEADER_Y, fixed],
        halfSize: [DOOR_HW, DOOR_HEADER_HALF_H, WALL_T],
      }
    : {
        pos: [fixed, DOOR_HEADER_Y, doorCenter],
        halfSize: [WALL_T, DOOR_HEADER_HALF_H, DOOR_HW],
      };

const windowSill = (axis: 'x' | 'z', fixed: number, winCenter: number): Obstacle =>
  axis === 'x'
    ? {
        pos: [winCenter, WIN_SILL_Y, fixed],
        halfSize: [WIN_HW, WIN_SILL_HALF_H, WALL_T],
      }
    : {
        pos: [fixed, WIN_SILL_Y, winCenter],
        halfSize: [WALL_T, WIN_SILL_HALF_H, WIN_HW],
      };

const windowHeader = (axis: 'x' | 'z', fixed: number, winCenter: number): Obstacle =>
  axis === 'x'
    ? {
        pos: [winCenter, WIN_HEADER_Y, fixed],
        halfSize: [WIN_HW, WIN_HEADER_HALF_H, WALL_T],
      }
    : {
        pos: [fixed, WIN_HEADER_Y, winCenter],
        halfSize: [WALL_T, WIN_HEADER_HALF_H, WIN_HW],
      };

const FRONT_DOOR_X = -3;
const NORTH_WINDOW_X = 3;
const EAST_WINDOW_Z = -3;
const WEST_WINDOW_Z = 3;
const NW_SW_DOOR_X = -3;
const NE_SE_DOOR_X = 3;
const NW_NE_DOOR_Z = 3;
const SW_SE_DOOR_Z = -3;

export const HOUSE_WALLS: readonly Obstacle[] = [
  // ---- South outer wall (z = -HOUSE_W), front door at x=-3 ----
  wallSegment('x', -HOUSE_W, -HOUSE_W, FRONT_DOOR_X - DOOR_HW),
  wallSegment('x', -HOUSE_W, FRONT_DOOR_X + DOOR_HW, HOUSE_W),
  doorHeader('x', -HOUSE_W, FRONT_DOOR_X),

  // ---- North outer wall (z = +HOUSE_W), window at x=+3 ----
  wallSegment('x', HOUSE_W, -HOUSE_W, NORTH_WINDOW_X - WIN_HW),
  wallSegment('x', HOUSE_W, NORTH_WINDOW_X + WIN_HW, HOUSE_W),
  windowSill('x', HOUSE_W, NORTH_WINDOW_X),
  windowHeader('x', HOUSE_W, NORTH_WINDOW_X),

  // ---- East outer wall (x = +HOUSE_W), window at z=-3 ----
  wallSegment('z', HOUSE_W, -HOUSE_W, EAST_WINDOW_Z - WIN_HW),
  wallSegment('z', HOUSE_W, EAST_WINDOW_Z + WIN_HW, HOUSE_W),
  windowSill('z', HOUSE_W, EAST_WINDOW_Z),
  windowHeader('z', HOUSE_W, EAST_WINDOW_Z),

  // ---- West outer wall (x = -HOUSE_W), window at z=+3 ----
  wallSegment('z', -HOUSE_W, -HOUSE_W, WEST_WINDOW_Z - WIN_HW),
  wallSegment('z', -HOUSE_W, WEST_WINDOW_Z + WIN_HW, HOUSE_W),
  windowSill('z', -HOUSE_W, WEST_WINDOW_Z),
  windowHeader('z', -HOUSE_W, WEST_WINDOW_Z),

  // ---- Interior E-W wall at z=0, doorways at x=-3 and x=+3 ----
  wallSegment('x', 0, -HOUSE_W, NW_SW_DOOR_X - DOOR_HW),
  wallSegment('x', 0, NW_SW_DOOR_X + DOOR_HW, NE_SE_DOOR_X - DOOR_HW),
  wallSegment('x', 0, NE_SE_DOOR_X + DOOR_HW, HOUSE_W),
  doorHeader('x', 0, NW_SW_DOOR_X),
  doorHeader('x', 0, NE_SE_DOOR_X),

  // ---- Interior N-S wall, north half (x=0, z 0..+HOUSE_W), door at z=+3 ----
  wallSegment('z', 0, 0, NW_NE_DOOR_Z - DOOR_HW),
  wallSegment('z', 0, NW_NE_DOOR_Z + DOOR_HW, HOUSE_W),
  doorHeader('z', 0, NW_NE_DOOR_Z),

  // ---- Interior N-S wall, south half (x=0, z -HOUSE_W..0), door at z=-3 ----
  wallSegment('z', 0, -HOUSE_W, SW_SE_DOOR_Z - DOOR_HW),
  wallSegment('z', 0, SW_SE_DOOR_Z + DOOR_HW, 0),
  doorHeader('z', 0, SW_SE_DOOR_Z),

  // ---- Roof ----
  { pos: [0, WALL_TOP_Y + 0.15, 0], halfSize: [HOUSE_W + 0.15, 0.15, HOUSE_W + 0.15] },
];

// Single source of truth for arena geometry. Both the client (rendering) and
// the server (collision) read from this list.
export const OBSTACLES: readonly Obstacle[] = [...HOUSE_WALLS, ...SCATTERED_OBSTACLES];
