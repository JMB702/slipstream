import {
  BOT,
  PLAYER,
  TICK_MS,
  WEAPON,
  type BotProfile,
  type InputFrame,
  type Vec3,
} from '@slipstream/shared';
import type { ServerPlayer } from '../state.js';
import { applyInput } from '../simulation.js';
import { planPath, randomPatrolGoal } from './path.js';
import {
  directionFromYawPitch,
  eyePosition,
  findVisibleTarget,
  hasLineOfSight,
  slewAngle,
  yawPitchToward,
} from './aim.js';

// Drive a bot one tick: pick state, plan path if needed, generate an input
// frame, and feed it through the existing applyInput pipeline so bots and
// humans share one simulation path. Returns true if the bot pressed fire
// (caller adds to pendingFire set).
export const tickBot = (
  bot: ServerPlayer,
  others: readonly ServerPlayer[],
  now: number,
  profile: BotProfile,
): boolean => {
  if (!bot.alive) {
    bot.botState = 'dead';
    bot.botPath = [];
    bot.botPathIdx = 0;
    bot.botTargetId = null;
    return false;
  }
  if (bot.botState === 'dead' || bot.botState === undefined) {
    bot.botState = 'patrol';
    bot.botPath = undefined;
    bot.botPathIdx = 0;
  }

  const targetCheckDue =
    bot.botLastTargetCheckAt === undefined ||
    now - bot.botLastTargetCheckAt >= BOT.targetReacquireMs;

  let target: ServerPlayer | null = null;
  if (targetCheckDue) {
    target = findVisibleTarget(bot, others, profile.fireRangeMax);
    bot.botLastTargetCheckAt = now;
    bot.botTargetId = target?.id ?? bot.botTargetId ?? null;
  } else if (bot.botTargetId) {
    target = others.find((p) => p.id === bot.botTargetId && p.alive) ?? null;
  }

  // Validate LOS for the cached target (cheap LOS check refreshed on its own
  // schedule so we're not raycasting every tick mid-engage).
  let hasLOS = false;
  if (target) {
    const losCheckDue =
      bot.botLastLosCheckAt === undefined ||
      now - bot.botLastLosCheckAt >= BOT.losCheckMs;
    if (losCheckDue) {
      hasLOS = hasLineOfSight(eyePosition(bot), eyePosition(target));
      bot.botLastLosCheckAt = now;
      if (hasLOS) bot.botLastSawTargetAt = now;
    } else {
      // Best-effort: assume LOS holds between checks unless we already lost it.
      hasLOS = bot.botLastSawTargetAt !== undefined && now - bot.botLastSawTargetAt < BOT.losCheckMs * 3;
    }
  }

  // State transition.
  if (target && hasLOS) {
    if (bot.botState !== 'engage') {
      bot.botState = 'engage';
      bot.botEngagedAt = now;
      bot.botPath = undefined;
    }
  } else if (target && !hasLOS && bot.botLastSawTargetAt !== undefined) {
    if (bot.botState !== 'hunt') {
      bot.botState = 'hunt';
      bot.botGoal = target.position;
      bot.botPath = undefined;
    } else {
      bot.botGoal = target.position;
    }
  } else {
    if (bot.botState !== 'patrol') {
      bot.botState = 'patrol';
      bot.botPath = undefined;
      bot.botGoal = null;
    }
  }

  // Plan / replan path for non-engage states.
  if (bot.botState !== 'engage') {
    const replanDue =
      bot.botLastReplanAt === undefined ||
      now - bot.botLastReplanAt >= BOT.pathReplanMs ||
      !bot.botPath ||
      bot.botPath.length === 0;
    if (replanDue) {
      const goal: Vec3 =
        bot.botState === 'hunt' && bot.botGoal
          ? bot.botGoal
          : (bot.botGoal ?? randomPatrolGoal(bot.position));
      bot.botGoal = goal;
      const path = planPath(bot.position, goal);
      bot.botPath = path ?? [goal];
      bot.botPathIdx = 0;
      bot.botLastReplanAt = now;
    }
    advancePathIfArrived(bot);
  }

  // Compute desired facing direction.
  let desiredYaw = bot.yaw;
  let desiredPitch = bot.pitch;
  if (bot.botState === 'engage' && target) {
    const aim = yawPitchToward(eyePosition(bot), eyePosition(target));
    desiredYaw = aim.yaw + jitter(profile.aimJitterRad);
    desiredPitch = aim.pitch + jitter(profile.aimJitterRad);
  } else {
    const next = currentWaypoint(bot);
    if (next) {
      const aim = yawPitchToward(bot.position, next);
      desiredYaw = aim.yaw;
      desiredPitch = 0;
    }
  }
  // Slew limits keep bots from snapping instantly onto a target.
  const dtSec = TICK_MS / 1000;
  const yaw = slewAngle(bot.yaw, desiredYaw, profile.aimYawRateRad * dtSec);
  const pitch = slewAngle(bot.pitch, desiredPitch, profile.aimPitchRateRad * dtSec);

  // Movement: pick a steering goal, decompose into forward/right relative to
  // the bot's CURRENT yaw (slewed value), so it can strafe-while-facing-target.
  let forward = 0;
  let right = 0;
  let sprint = false;
  let jump = false;

  const now2 = now;
  if (bot.botState === 'engage' && target) {
    const distToTarget = horizDist(bot.position, target.position);
    if (distToTarget < profile.fireRangeMin) {
      // Too close — back-pedal.
      const back = subtract(bot.position, target.position);
      const fr = decomposeMovement(back, yaw);
      forward = clamp(fr.forward, -1, 1);
      right = clamp(fr.right, -1, 1);
    } else {
      // Lazy strafe: flip direction every ~700ms so we're not a stationary
      // duck. Fed entirely as `right` input; forward stays 0 unless we want
      // to close.
      if (bot.botStrafeFlipAt === undefined || now2 >= bot.botStrafeFlipAt) {
        bot.botStrafeSign = bot.botStrafeSign === 1 ? -1 : 1;
        if (bot.botStrafeSign === undefined || bot.botStrafeSign === 0) bot.botStrafeSign = 1;
        bot.botStrafeFlipAt = now2 + 600 + Math.random() * 400;
      }
      right = bot.botStrafeSign ?? 1;
      // Light forward press if target is far inside max range.
      if (distToTarget > profile.fireRangeMax * 0.7) forward = 0.5;
    }
  } else {
    const next = currentWaypoint(bot);
    if (next) {
      const distToWaypoint = horizDist(bot.position, next);
      sprint = distToWaypoint > BOT.sprintWhenFurtherThan;
      const dir = subtract(next, bot.position);
      const fr = decomposeMovement(dir, yaw);
      forward = clamp(fr.forward, -1, 1);
      right = clamp(fr.right, -1, 1);
    }
  }

  // Stuck detection: if we're meant to be moving and we're crawling, jump and
  // force a replan. The doorways are tight; an occasional nudge unwedges the
  // bot from a wall corner.
  const wantsToMove = forward !== 0 || right !== 0;
  const speed2D = Math.hypot(bot.velocity[0], bot.velocity[2]);
  if (wantsToMove && speed2D < BOT.stuckSpeed) {
    if (bot.botStuckSince === undefined) bot.botStuckSince = now;
    if (now - (bot.botStuckSince ?? now) >= BOT.stuckMs) {
      jump = true;
      bot.botPath = undefined;
      bot.botStuckSince = undefined;
    }
  } else {
    bot.botStuckSince = undefined;
  }

  // Reload when ammo is low and we're not actively shooting.
  const wantsReload =
    !bot.reloading &&
    bot.ammo <= BOT.reloadAmmoThreshold &&
    bot.botState !== 'engage';

  // Fire when in engage, target visible, reaction delay elapsed, ammo > 0, not reloading.
  let fire = false;
  if (
    bot.botState === 'engage' &&
    target &&
    hasLOS &&
    !bot.reloading &&
    bot.ammo > 0 &&
    bot.botEngagedAt !== undefined &&
    now - bot.botEngagedAt >= profile.engageReachMs
  ) {
    // Aim must actually be on target — don't fire before slew lands.
    const aimDir = directionFromYawPitch(yaw, pitch);
    const toTarget = subtract(eyePosition(target), eyePosition(bot));
    const len = Math.hypot(toTarget[0], toTarget[1], toTarget[2]);
    if (len > 1e-4) {
      const dot =
        (aimDir[0] * toTarget[0] +
          aimDir[1] * toTarget[1] +
          aimDir[2] * toTarget[2]) /
        len;
      if (dot > profile.fireAimDotMin) {
        // Easy bots randomly skip on-target ticks so the player has breathing
        // room even after a clean lock-on.
        if (profile.fireDropoutChance <= 0 || Math.random() >= profile.fireDropoutChance) {
          fire = true;
        }
      }
    }
  }

  // Build the input frame and route it through the same pipeline humans use.
  const seq = (bot.botInputSeq ?? 0) + 1;
  bot.botInputSeq = seq;
  const frame: InputFrame = {
    seq,
    dtMs: TICK_MS,
    forward,
    right,
    jump,
    // Server already demotes sprint+fire to walk+fire — trusting the existing
    // rule rather than re-implementing it here.
    sprint: sprint && !fire,
    fire,
    reload: wantsReload,
    yaw,
    pitch,
  };
  applyInput(bot, frame, now);
  return fire;
};

const currentWaypoint = (bot: ServerPlayer): Vec3 | null => {
  if (!bot.botPath || bot.botPath.length === 0) return null;
  const idx = Math.min(bot.botPathIdx ?? 0, bot.botPath.length - 1);
  return bot.botPath[idx]!;
};

const advancePathIfArrived = (bot: ServerPlayer): void => {
  if (!bot.botPath || bot.botPath.length === 0) return;
  let idx = bot.botPathIdx ?? 0;
  while (idx < bot.botPath.length) {
    const wp = bot.botPath[idx]!;
    if (horizDist(bot.position, wp) > BOT.waypointArriveDist) break;
    idx += 1;
  }
  bot.botPathIdx = idx;
  if (idx >= bot.botPath.length) {
    // Reached the end — clear so we plan a new patrol next tick.
    bot.botPath = undefined;
    bot.botPathIdx = 0;
    bot.botGoal = null;
  }
};

const decomposeMovement = (
  worldDir: Vec3,
  yaw: number,
): { forward: number; right: number } => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // Inverse of sim.ts movement: vx = -sin*fwd + cos*right, vz = -cos*fwd - sin*right.
  // Solving for fwd/right given a target world vector (dx, dz):
  const dx = worldDir[0];
  const dz = worldDir[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return { forward: 0, right: 0 };
  const nx = dx / len;
  const nz = dz / len;
  const forward = -sy * nx - cy * nz;
  const right = cy * nx - sy * nz;
  return { forward, right };
};

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const horizDist = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
};

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

// Crude approximation of a Gaussian by averaging two uniform draws — enough
// noise to make bots not feel like aimbots.
const jitter = (amount: number): number => {
  const u = (Math.random() + Math.random()) / 2 - 0.5;
  return u * 2 * amount;
};

// Exposed for spawn-time setup — keeps bot fire-rate matched to humans by
// forcing an initial gap on join.
export const ensureBotDefaults = (bot: ServerPlayer, now: number): void => {
  bot.botState = 'patrol';
  bot.botPath = undefined;
  bot.botPathIdx = 0;
  bot.botGoal = null;
  bot.botTargetId = null;
  bot.botLastReplanAt = undefined;
  bot.botLastTargetCheckAt = undefined;
  bot.botLastLosCheckAt = undefined;
  bot.botLastSawTargetAt = undefined;
  bot.botEngagedAt = undefined;
  bot.botInputSeq = 0;
  bot.botStuckSince = undefined;
  bot.botStrafeSign = 1;
  bot.botStrafeFlipAt = now;
  // Treat the join time as integration baseline so integrateIdle doesn't
  // immediately deluge gravity into them on tick 1.
  bot.lastIntegratedAt = now;
  // Sanity: full ammo so we don't get an instant-reload on spawn.
  bot.ammo = WEAPON.magazineSize;
  bot.health = PLAYER.maxHealth;
};
