import { PLAYER, WEAPON, raycastObstacles, type Vec3 } from '@slipstream/shared';

// Last time (performance.now() ms) the local player's aim was on each remote
// player. Updated once per frame from LocalPlayer; read every frame from
// PlayerModel to drive enemy nameplate reveal-on-aim with a fade-out delay.
//
// Singleton module-scope map so we don't pay zustand re-render cost on every
// frame for what is purely a transient client-side display flag.
const lastAimedAt = new Map<string, number>();

export const stampAimedAt = (id: string, t: number): void => {
  lastAimedAt.set(id, t);
};

export const getLastAimedAt = (id: string): number => lastAimedAt.get(id) ?? 0;

export const clearAimState = (): void => {
  lastAimedAt.clear();
};

// Eye height for aim-origin: matches server (apps/party/src/simulation.ts).
const EYE_OFFSET_Y = PLAYER.height * 0.3;
const HIT_RADIUS = PLAYER.height * 0.4;

const directionFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [-sy * cp, sp, -cy * cp];
};

const raySphere = (
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  radius: number,
  maxDist: number,
): number | null => {
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t = -b - sq;
  if (t < 0 || t > maxDist) return null;
  return t;
};

export interface AimTarget {
  position: Vec3;
  id: string;
  alive: boolean;
}

// Returns the id of the player currently under the local player's reticle, or
// null. Mirrors the server's tryFire raycast: nearest live player along the
// ray, but only if no obstacle is closer (so you can't "see through" walls).
export const findAimTarget = (
  myPos: Vec3,
  yaw: number,
  pitch: number,
  myId: string,
  targets: Iterable<AimTarget>,
): string | null => {
  const origin: Vec3 = [myPos[0], myPos[1] + EYE_OFFSET_Y, myPos[2]];
  const dir = directionFromYawPitch(yaw, pitch);
  const wallT = raycastObstacles(origin, dir, WEAPON.range);
  let bestId: string | null = null;
  let bestT = wallT ?? WEAPON.range;
  for (const p of targets) {
    if (p.id === myId || !p.alive) continue;
    const t = raySphere(origin, dir, p.position, HIT_RADIUS, WEAPON.range);
    if (t !== null && t < bestT) {
      bestT = t;
      bestId = p.id;
    }
  }
  return bestId;
};
