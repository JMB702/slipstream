import { MAP, OBSTACLES, PLAYER, type PlayerState, type Vec3 } from '@slipstream/shared';

export interface ServerPlayer extends PlayerState {
  connectionId: string;
  pendingInputSeq: number;
  grounded: boolean;
  // Wall-clock time (ms, server frame) of the last physics integration.
  // runTick uses this to fill gaps when a player isn't sending inputs so they
  // don't freeze in mid-air after spawn or during an AFK pause.
  lastIntegratedAt: number;
}

export const initialPlayer = (
  connectionId: string,
  id: string,
  name: string,
  spawn: Vec3,
  now: number,
): ServerPlayer => ({
  id,
  connectionId,
  name,
  position: spawn,
  velocity: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  health: PLAYER.maxHealth,
  alive: true,
  respawnAt: null,
  ammo: 30,
  reloading: false,
  reloadDoneAt: null,
  kills: 0,
  deaths: 0,
  lastSeenSeq: 0,
  pendingInputSeq: 0,
  grounded: true,
  lastIntegratedAt: now,
});

export const randomSpawn = (): Vec3 => {
  // Reject candidates that overlap an obstacle's inflated AABB so we don't
  // spawn the player stuck inside a box.
  const half = MAP.size / 2 - 4;
  const r = PLAYER.radius;
  const halfH = PLAYER.height / 2;
  for (let attempt = 0; attempt < 32; attempt++) {
    const x = (Math.random() * 2 - 1) * half;
    const z = (Math.random() * 2 - 1) * half;
    const y = MAP.spawnHeight;
    if (!insideAnyObstacle(x, y, z, r, halfH)) {
      return [x, y, z];
    }
  }
  // Fallback: world origin should always be open enough at floor height.
  return [0, MAP.spawnHeight, 0];
};

const insideAnyObstacle = (
  x: number,
  y: number,
  z: number,
  r: number,
  halfH: number,
): boolean => {
  for (const o of OBSTACLES) {
    if (
      x > o.pos[0] - o.halfSize[0] - r &&
      x < o.pos[0] + o.halfSize[0] + r &&
      y > o.pos[1] - o.halfSize[1] - halfH &&
      y < o.pos[1] + o.halfSize[1] + halfH &&
      z > o.pos[2] - o.halfSize[2] - r &&
      z < o.pos[2] + o.halfSize[2] + r
    ) {
      return true;
    }
  }
  return false;
};
