import { MAP, OBSTACLES, PLAYER, type CharacterId, type PlayerState, type Vec3 } from '@slipstream/shared';

export type BotState = 'patrol' | 'hunt' | 'engage' | 'reposition' | 'dead';

export interface ServerPlayer extends PlayerState {
  connectionId: string;
  pendingInputSeq: number;
  grounded: boolean;
  // Wall-clock time (ms, server frame) of the last physics integration.
  // runTick uses this to fill gaps when a player isn't sending inputs so they
  // don't freeze in mid-air after spawn or during an AFK pause.
  lastIntegratedAt: number;
  // Wall-clock time (ms, server frame) the player last took damage.
  // Health regen kicks in once `now - lastDamagedAt >= PLAYER.regenDelayMs`.
  lastDamagedAt: number;
  // Window-vault state. When `vaultEndAt` is non-null, the server is tweening
  // the player from `vaultFrom` to `vaultTo` and ignores movement input until
  // `now >= vaultEndAt`. The wire-visible `vaulting` boolean on PlayerState
  // mirrors `vaultEndAt !== null`.
  vaultFrom: Vec3 | null;
  vaultTo: Vec3 | null;
  vaultEndAt: number | null;
  // Per-bot controller state. None of these cross the wire — stripped in
  // server.ts before broadcast. All optional so humans pay no extra cost.
  botState?: BotState;
  botPath?: Vec3[];
  botPathIdx?: number;
  botGoal?: Vec3 | null;
  botTargetId?: string | null;
  botLastReplanAt?: number;
  botLastTargetCheckAt?: number;
  botLastLosCheckAt?: number;
  botLastSawTargetAt?: number;
  botEngagedAt?: number;
  botInputSeq?: number;
  botStuckSince?: number;
  botSawTargetSince?: number;
  botStrafeSign?: number;
  botStrafeFlipAt?: number;
}

export const initialPlayer = (
  connectionId: string,
  id: string,
  name: string,
  spawn: Vec3,
  now: number,
  options?: { isBot?: boolean; characterId?: CharacterId },
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
  vaulting: false,
  kills: 0,
  deaths: 0,
  lastSeenSeq: 0,
  isBot: options?.isBot ?? false,
  characterId: options?.characterId ?? 'soldier',
  pendingInputSeq: 0,
  grounded: true,
  lastIntegratedAt: now,
  lastDamagedAt: 0,
  vaultFrom: null,
  vaultTo: null,
  vaultEndAt: null,
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
