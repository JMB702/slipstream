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

interface CameraRayHit {
  /** ID of the player under the reticle, or null if it landed on a wall. */
  playerId: string | null;
  /** World-space point where the ray terminates (player capsule, wall, or max range). */
  point: Vec3;
}

// Cast from the camera (third-person eye-of-the-player view ray) and resolve
// the nearest player or wall hit. Used for two things:
//
//   1) Enemy nameplate reveal — `playerId` says who the reticle is on.
//   2) Wire-format `aim` for InputFrame — `point` is what the server fires
//      AT (origin = camera position). This is the fix for the third-person
//      camera-vs-eye parallax: the camera sees over a ledge that the eye
//      is behind, so reticle-says-hit but eye-says-blocked. Camera-anchored
//      cast resolves that correctly.
//
// Pass live (rendered) target positions; the server still does its own
// authoritative lag-compensated test from the same camera origin/direction
// when a fire input arrives.
export const castCameraRay = (
  camOrigin: Vec3,
  camForward: Vec3,
  myId: string,
  targets: Iterable<AimTarget>,
): CameraRayHit => {
  const wallT = raycastObstacles(camOrigin, camForward, WEAPON.range);
  let bestId: string | null = null;
  let bestT = wallT ?? WEAPON.range;
  for (const p of targets) {
    if (p.id === myId || !p.alive) continue;
    const t = rayCapsuleVertical(
      camOrigin,
      camForward,
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
  return {
    playerId: bestId,
    point: [
      camOrigin[0] + camForward[0] * bestT,
      camOrigin[1] + camForward[1] * bestT,
      camOrigin[2] + camForward[2] * bestT,
    ],
  };
};

// Backward-compat shim used by code paths that only need the player id under
// the reticle (e.g. nameplate reveal). Eye-anchored — fine for that purpose
// because mismatch with camera-anchored is small at distance and the visual
// "is the reticle on them" answer is what the player perceives anyway.
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
