import {
  PLAYER,
  WEAPON,
  rayCapsuleVertical,
  raycastObstacles,
  type Vec3,
} from '@slipstream/shared';

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

// Eye height + hit-volume mirror server's player-raycast in
// apps/party/src/simulation.ts. Keep them in lockstep so reveal-on-aim and
// actual-hit feel like the same operation to the player.
const EYE_OFFSET_Y = PLAYER.height * 0.3;
const HIT_RADIUS = PLAYER.radius + 0.1;
const HALF_SEGMENT = PLAYER.height / 2 - PLAYER.radius;

const directionFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [-sy * cp, sp, -cy * cp];
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
    const t = rayCapsuleVertical(
      origin,
      dir,
      p.position[0],
      p.position[2],
      p.position[1] - HALF_SEGMENT,
      p.position[1] + HALF_SEGMENT,
      HIT_RADIUS,
      WEAPON.range,
    );
    if (t !== null && t < bestT) {
      bestT = t;
      bestId = p.id;
    }
  }
  return bestId;
};
