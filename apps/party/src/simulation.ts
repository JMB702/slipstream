import {
  MAP,
  PLAYER,
  TICK_MS,
  VAULT,
  WEAPON,
  WINDOWS,
  applyMovement,
  raycastObstacles,
  type GameEvent,
  type InputFrame,
  type Vec3,
  type WindowDef,
} from '@slipstream/shared';
import type { ServerPlayer } from './state.js';
import { randomSpawn } from './state.js';

export const applyInput = (player: ServerPlayer, input: InputFrame, now: number): void => {
  if (!player.alive) {
    player.lastSeenSeq = input.seq;
    return;
  }
  // Vaulting: server-driven tween owns position; just keep yaw/pitch fresh
  // so the camera follows the player's view, and ack the input.
  if (player.vaultEndAt !== null) {
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.lastSeenSeq = input.seq;
    return;
  }
  // Edge-trigger: if jump was pressed AND we're standing near a window we
  // can vault through, start the vault instead of running normal movement.
  if (input.jump && player.grounded) {
    const plan = planVault(player);
    if (plan !== null) {
      player.vaultFrom = plan.from;
      player.vaultTo = plan.to;
      player.vaultEndAt = now + VAULT.durationMs;
      player.vaulting = true;
      player.position = plan.from;
      player.velocity = [0, 0, 0];
      player.grounded = false;
      player.yaw = input.yaw;
      player.pitch = input.pitch;
      player.lastSeenSeq = input.seq;
      player.lastIntegratedAt = now;
      return;
    }
  }
  const next = applyMovement(player, input);
  player.position = next.position;
  player.velocity = next.velocity;
  player.yaw = next.yaw;
  player.pitch = next.pitch;
  player.grounded = next.grounded;
  player.lastSeenSeq = input.seq;
  player.lastIntegratedAt = now;

  if (input.reload && !player.reloading && player.ammo < WEAPON.magazineSize) {
    player.reloading = true;
    player.reloadDoneAt = now + WEAPON.reloadMs;
  }
};

interface VaultPlan {
  from: Vec3;
  to: Vec3;
}

const planVault = (player: ServerPlayer): VaultPlan | null => {
  const fwdX = -Math.sin(player.yaw);
  const fwdZ = -Math.cos(player.yaw);
  let best: { window: WindowDef; throughDist: number; signedThrough: number } | null = null;

  for (const w of WINDOWS) {
    const along = w.axis === 'x' ? player.position[0] : player.position[2];
    const through = w.axis === 'x' ? player.position[2] : player.position[0];
    const fwdThrough = w.axis === 'x' ? fwdZ : fwdX;
    const offsetThrough = through - w.wallCoord;

    if (Math.abs(offsetThrough) > VAULT.triggerRange) continue;
    if (Math.abs(along - w.openingCenter) > w.openingHalfWidth + VAULT.lateralSlack) continue;
    // Must face TOWARD the wall: forward's through-axis sign opposite to player's offset
    if (Math.sign(fwdThrough) === Math.sign(offsetThrough)) continue;
    if (Math.sign(offsetThrough) === 0) continue; // standing exactly on the wall — no clear direction
    if (Math.abs(fwdThrough) < VAULT.facingMin) continue;

    if (best === null || Math.abs(offsetThrough) < best.throughDist) {
      best = { window: w, throughDist: Math.abs(offsetThrough), signedThrough: offsetThrough };
    }
  }
  if (best === null) return null;

  const { window: w, signedThrough } = best;
  // Don't lateral-snap on trigger — that visibly slides the player sideways
  // at vault start. Tween from the player's actual current position to the
  // opening-centered exit on the opposite side, so any lateral correction
  // happens smoothly across the vault duration.
  const exitSign = -Math.sign(signedThrough);
  const toAlong = w.openingCenter;
  const toThrough = w.wallCoord + exitSign * VAULT.exitOffset;
  const y = MAP.spawnHeight;
  const from: Vec3 = [player.position[0], y, player.position[2]];
  const to: Vec3 =
    w.axis === 'x' ? [toAlong, y, toThrough] : [toThrough, y, toAlong];
  return { from, to };
};

// Drive the position tween while a vault is in progress. Called every tick
// from the room's tick loop. When the vault ends, snaps to destination and
// clears the state so normal movement resumes.
export const tickVault = (player: ServerPlayer, now: number): void => {
  if (player.vaultEndAt === null || player.vaultFrom === null || player.vaultTo === null) return;
  if (now >= player.vaultEndAt) {
    player.position = player.vaultTo;
    player.velocity = [0, 0, 0];
    player.grounded = true;
    player.vaultFrom = null;
    player.vaultTo = null;
    player.vaultEndAt = null;
    player.vaulting = false;
    player.lastIntegratedAt = now;
    return;
  }
  const total = VAULT.durationMs;
  const remaining = player.vaultEndAt - now;
  const t = Math.max(0, Math.min(1, 1 - remaining / total));
  const f = player.vaultFrom;
  const to = player.vaultTo;
  // Sin arc so the player rises and lands without a discontinuity.
  const arc = Math.sin(t * Math.PI) * VAULT.arcHeight;
  player.position = [
    f[0] + (to[0] - f[0]) * t,
    f[1] + (to[1] - f[1]) * t + arc,
    f[2] + (to[2] - f[2]) * t,
  ];
  player.lastIntegratedAt = now;
};

// Fill physics gaps for players who aren't sending inputs (idle, AFK, just spawned).
// Without this, gravity never runs for them and they freeze at the spawn height.
//
// CRITICAL: this only runs when the player is genuinely idle (no input within
// the last ~1.5 ticks). For an active player, applyInput handles physics on
// every frame; running integrateIdle on top of it would overwrite the
// just-computed velocity with (0, 0, 0) — the network would see velocity
// alternating between intended and zero, and animation state machines on the
// client would oscillate between Walk and Idle.
const IDLE_THRESHOLD_MS = TICK_MS * 1.5;

export const integrateIdle = (player: ServerPlayer, now: number): void => {
  if (!player.alive) {
    player.lastIntegratedAt = now;
    return;
  }
  // Vault tween owns position; don't apply gravity over the top of it.
  if (player.vaultEndAt !== null) return;
  const dtMs = now - player.lastIntegratedAt;
  if (dtMs < IDLE_THRESHOLD_MS) return;
  const idleFrame: InputFrame = {
    seq: 0,
    dtMs,
    forward: 0,
    right: 0,
    jump: false,
    sprint: false,
    fire: false,
    reload: false,
    yaw: player.yaw,
    pitch: player.pitch,
  };
  const next = applyMovement(player, idleFrame);
  player.position = next.position;
  player.velocity = next.velocity;
  player.grounded = next.grounded;
  player.lastIntegratedAt = now;
};

export const finishReload = (player: ServerPlayer, now: number): void => {
  if (player.reloading && player.reloadDoneAt !== null && now >= player.reloadDoneAt) {
    player.ammo = WEAPON.magazineSize;
    player.reloading = false;
    player.reloadDoneAt = null;
  }
};

export const maybeRespawn = (player: ServerPlayer, now: number): void => {
  if (!player.alive && player.respawnAt !== null && now >= player.respawnAt) {
    player.position = randomSpawn();
    player.velocity = [0, 0, 0];
    player.health = PLAYER.maxHealth;
    player.alive = true;
    player.respawnAt = null;
    player.ammo = WEAPON.magazineSize;
    player.reloading = false;
    player.reloadDoneAt = null;
    player.grounded = true;
    player.lastIntegratedAt = now;
    player.lastDamagedAt = 0;
    player.vaultFrom = null;
    player.vaultTo = null;
    player.vaultEndAt = null;
    player.vaulting = false;
  }
};

// Out-of-combat health regen (CoD/Halo style). Runs every tick; only heals
// after `regenDelayMs` of no damage. Heals at `regenPerSec` and clamps at max.
export const regenHealth = (player: ServerPlayer, now: number): void => {
  if (!player.alive) return;
  if (player.health >= PLAYER.maxHealth) return;
  if (now - player.lastDamagedAt < PLAYER.regenDelayMs) return;
  player.health = Math.min(
    PLAYER.maxHealth,
    player.health + PLAYER.regenPerSec * (TICK_MS / 1000),
  );
};

export const tryFire = (
  shooter: ServerPlayer,
  others: ServerPlayer[],
  now: number,
): GameEvent[] => {
  if (!shooter.alive || shooter.reloading || shooter.vaultEndAt !== null || shooter.ammo <= 0) return [];

  shooter.ammo -= 1;

  // Eye sits a bit above body center (so muzzle flashes don't come out of the chest).
  const eyeOrigin: Vec3 = [
    shooter.position[0],
    shooter.position[1] + PLAYER.height * 0.3,
    shooter.position[2],
  ];

  const dir = directionFromYawPitch(shooter.yaw, shooter.pitch);

  const playerHit = raycastPlayers(eyeOrigin, dir, WEAPON.range, others, shooter.id);
  const wallT = raycastObstacles(eyeOrigin, dir, WEAPON.range);

  // Shot is blocked if a wall is closer than the nearest player.
  const blocked = wallT !== null && (playerHit === null || wallT < playerHit.t);
  const effectiveHit = blocked ? null : playerHit;
  const stopT =
    blocked && wallT !== null
      ? wallT
      : effectiveHit !== null
        ? effectiveHit.t
        : WEAPON.range;

  const events: GameEvent[] = [
    {
      type: 'shot',
      shooterId: shooter.id,
      origin: eyeOrigin,
      // Direction is unit; we encode the effective tracer length by scaling so
      // the client renders a beam to the impact point, not 80m past the wall.
      direction: [dir[0] * (stopT / WEAPON.range), dir[1] * (stopT / WEAPON.range), dir[2] * (stopT / WEAPON.range)],
      hit: effectiveHit?.hitId ?? null,
      at: now,
    },
  ];

  if (effectiveHit) {
    const victim = others.find((p) => p.id === effectiveHit.hitId);
    if (victim && victim.alive) {
      victim.health -= WEAPON.damage;
      victim.lastDamagedAt = now;
      if (victim.health <= 0) {
        victim.health = 0;
        victim.alive = false;
        victim.respawnAt = now + PLAYER.respawnMs;
        victim.deaths += 1;
        shooter.kills += 1;
        events.push({
          type: 'kill',
          killerId: shooter.id,
          victimId: victim.id,
          at: now,
        });
      }
    }
  }

  return events;
};

const directionFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [-sy * cp, sp, -cy * cp];
};

interface RayHit {
  hitId: string;
  t: number;
}

const raycastPlayers = (
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  targets: ServerPlayer[],
  excludeId: string,
): RayHit | null => {
  let best: RayHit | null = null;
  // Approximate the capsule with a fat sphere covering most of the body.
  // Slightly over-generous laterally but reliable until we add proper capsule tests.
  const hitRadius = PLAYER.height * 0.4;
  for (const p of targets) {
    if (p.id === excludeId || !p.alive) continue;
    const t = raySphere(origin, dir, p.position, hitRadius, maxDist);
    if (t !== null && (best === null || t < best.t)) {
      best = { hitId: p.id, t };
    }
  }
  return best;
};

const raySphere = (
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  radius: number,
  maxDist: number,
): number | null => {
  // The target's body sphere is centered at its position (capsule center).
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

