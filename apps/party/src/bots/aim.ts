import { PLAYER, raycastObstacles, type Vec3 } from '@slipstream/shared';
import type { ServerPlayer } from '../state.js';

// Eye height for aim-origin: matches client (apps/client/src/game/aim-state.ts)
// and server tryFire (apps/party/src/simulation.ts).
const EYE_OFFSET_Y = PLAYER.height * 0.3;

export const eyePosition = (p: ServerPlayer): Vec3 => [
  p.position[0],
  p.position[1] + EYE_OFFSET_Y,
  p.position[2],
];

export const directionFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [-sy * cp, sp, -cy * cp];
};

export const yawPitchToward = (from: Vec3, to: Vec3): { yaw: number; pitch: number } => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const horiz = Math.sqrt(dx * dx + dz * dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, horiz);
  return { yaw, pitch };
};

// True if `from` has clear line-of-sight to `to` (no obstacle along the ray).
export const hasLineOfSight = (from: Vec3, to: Vec3): boolean => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-4) return true;
  const dir: Vec3 = [dx / len, dy / len, dz / len];
  const t = raycastObstacles(from, dir, len);
  return t === null;
};

// Closest live enemy with clear LOS, within `maxRange`. Excludes self and any
// id in `excludeIds` (lets the bot avoid targeting its own kind if you want
// FFA bot-vs-bot off; default is FFA — bots target each other and humans).
export const findVisibleTarget = (
  shooter: ServerPlayer,
  others: readonly ServerPlayer[],
  maxRange: number,
): ServerPlayer | null => {
  const eye = eyePosition(shooter);
  let best: ServerPlayer | null = null;
  let bestDist = Infinity;
  for (const t of others) {
    if (t.id === shooter.id || !t.alive) continue;
    const dx = t.position[0] - shooter.position[0];
    const dy = t.position[1] - shooter.position[1];
    const dz = t.position[2] - shooter.position[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > maxRange) continue;
    const targetEye: Vec3 = [
      t.position[0],
      t.position[1] + EYE_OFFSET_Y,
      t.position[2],
    ];
    if (!hasLineOfSight(eye, targetEye)) continue;
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
};

// Tween `current` toward `target` (radians) at most `maxStep`, choosing the
// shorter direction across the ±π wrap.
export const slewAngle = (current: number, target: number, maxStep: number): number => {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
};
