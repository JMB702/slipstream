import type * as Party from 'partykit/server';
import {
  BOT,
  BOT_PROFILES,
  DEFAULT_MAP_ID,
  MATCH,
  MAX_PLAYERS,
  PLAYER,
  SNAPSHOT_MS,
  TICK_MS,
  WEAPON,
  decode,
  encode,
  isBotDifficulty,
  isMapId,
  setActiveMap,
  type BotDifficulty,
  type ClientMessage,
  type GameEvent,
  type GameSnapshot,
  type ServerMessage,
} from '@slipstream/shared';
import {
  applyInput,
  finishReload,
  integrateIdle,
  maybeRespawn,
  pushPositionHistory,
  regenHealth,
  tickVault,
  tryFire,
} from './simulation.js';
import { initialPlayer, randomSpawn, type ServerPlayer } from './state.js';
import { ensureBotDefaults, tickBot } from './bots/controller.js';

export default class SlipstreamServer implements Party.Server {
  readonly options: Party.ServerOptions = {
    hibernate: false,
  };

  private players = new Map<string, ServerPlayer>();
  private pendingFire = new Set<string>();
  private events: GameEvent[] = [];
  private tick = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  // Match-mode state. killTarget is locked the moment the room first gets
  // a player (the first joiner picks via ?killTarget=); subsequent joiners
  // can't change it. Winner+resetAt set together when someone hits the
  // target; resetAt fires once and clears both, starting a fresh round.
  private killTarget: number = MATCH.defaultKillTarget;
  private killTargetLocked = false;
  // Bot count is locked alongside killTarget by the first joiner. Locked
  // separately so refreshing the host doesn't change the in-progress match.
  private botCount: number = MATCH.defaultBotCount;
  private botCountLocked = false;
  private botDifficulty: BotDifficulty = MATCH.defaultBotDifficulty;
  private winnerId: string | null = null;
  private resetAt: number | null = null;

  constructor(readonly room: Party.Room) {}

  onStart(): void {
    this.startedAt = Date.now();
    // The PartyKit room id IS the map id — Lobby's dropdown maps directly
    // onto room name. Unknown ids fall back to the default map so dev/test
    // rooms with arbitrary names still boot something playable.
    setActiveMap(isMapId(this.room.id) ? this.room.id : DEFAULT_MAP_ID);
    this.startTimers();
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    const url = new URL(ctx.request.url);

    // Reject mismatched map ids up front so the client can't silently end
    // up in a room whose physics differ from what the lobby promised.
    const queryMap = url.searchParams.get('mapId');
    const expected = isMapId(this.room.id) ? this.room.id : DEFAULT_MAP_ID;
    if (queryMap && queryMap !== expected) {
      conn.close(4002, `wrong map: room is ${expected}`);
      return;
    }

    // Optional access-code gate. If ACCESS_CODE is set in the room's env
    // (apps/party/.env in dev, `partykit env add` in prod), every
    // connection must present a matching ?accessCode= or the socket is
    // closed with code 4003. Unset = no gate (handy in CI / private LAN).
    // PartyKit exposes env on Room — process.env is NOT populated in the
    // Workers runtime, so reading from this.room.env is the only path that
    // works in both dev and prod.
    const required = (this.room.env.ACCESS_CODE as string | undefined) ?? '';
    if (required) {
      const provided = url.searchParams.get('accessCode') ?? '';
      if (provided !== required) {
        conn.close(4003, 'invalid access code');
        return;
      }
    }

    if (this.players.size >= MAX_PLAYERS) {
      conn.close(4001, 'room full');
      return;
    }
    const name = (url.searchParams.get('name') ?? 'Player').slice(0, 24) || 'Player';
    if (!this.killTargetLocked) {
      const raw = url.searchParams.get('killTarget');
      const parsed = raw == null ? NaN : Math.floor(Number(raw));
      if (Number.isFinite(parsed)) {
        this.killTarget = Math.max(
          MATCH.minKillTarget,
          Math.min(MATCH.maxKillTarget, parsed),
        );
      }
      this.killTargetLocked = true;
    }
    if (!this.botCountLocked) {
      const raw = url.searchParams.get('botCount');
      const parsed = raw == null ? NaN : Math.floor(Number(raw));
      if (Number.isFinite(parsed)) {
        this.botCount = Math.max(
          MATCH.minBotCount,
          Math.min(MATCH.maxBotCount, parsed),
        );
      }
      const rawDiff = url.searchParams.get('botDifficulty') ?? '';
      if (isBotDifficulty(rawDiff)) this.botDifficulty = rawDiff;
      // Difficulty is locked alongside botCount — refreshing the host can't
      // soften live opponents mid-match.
      this.botCountLocked = true;
    }
    const player = initialPlayer(conn.id, conn.id, name, randomSpawn(), this.serverTime(), {
      isBot: false,
      characterId: 'soldier',
    });
    this.players.set(conn.id, player);
    this.spawnBots(this.serverTime());

    // If the room had emptied out, timers were stopped — restart them now.
    this.startTimers();

    this.send(conn, {
      type: 'welcome',
      you: player.id,
      serverTime: this.serverTime(),
    });
    this.broadcastSnapshot();
  }

  private startTimers(): void {
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.runTick(), TICK_MS);
    }
    if (this.snapshotTimer === null) {
      this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), SNAPSHOT_MS);
    }
  }

  onMessage(raw: string, sender: Party.Connection): void {
    const player = this.players.get(sender.id);
    if (!player) return;

    let msg: ClientMessage;
    try {
      msg = decode<ClientMessage>(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        player.name = (msg.name ?? 'Player').slice(0, 24) || 'Player';
        return;
      }
      case 'input': {
        const now = this.serverTime();
        const frozen = this.winnerId !== null;
        for (const frame of msg.frames) {
          if (frame.seq <= player.lastSeenSeq) continue;
          // No firing while sprinting — silently demote sprint when fire is
          // pressed. Player walks-while-firing instead of running-while-firing.
          // Reloading at sprint speed is allowed; the client picks ReloadRun.
          // Also drop fire entirely while the round is in victory-freeze.
          let effectiveFrame =
            frame.fire && frame.sprint ? { ...frame, sprint: false } : frame;
          if (frozen && effectiveFrame.fire) {
            effectiveFrame = { ...effectiveFrame, fire: false };
          }
          applyInput(player, effectiveFrame, now);
          if (effectiveFrame.fire) this.pendingFire.add(player.id);
        }
        return;
      }
      case 'chat': {
        const text = (msg.text ?? '').slice(0, 200);
        if (!text.trim()) return;
        this.events.push({
          type: 'chat',
          fromId: player.id,
          fromName: player.name,
          text,
          at: this.serverTime(),
        });
        return;
      }
      case 'ping': {
        this.send(sender, { type: 'pong', t: msg.t, serverTime: this.serverTime() });
        return;
      }
    }
  }

  onClose(conn: Party.Connection): void {
    this.players.delete(conn.id);
    this.pendingFire.delete(conn.id);
    // If the only humans are gone, drop the bots too — no point simulating an
    // empty arena. They respawn with the next human via spawnBots().
    if (this.humanCount() === 0) {
      this.removeAllBots();
    }
    if (this.players.size === 0) {
      this.stopTimers();
      // Empty room — release the killTarget and botCount locks so the next
      // first-joiner can pick fresh values.
      this.killTargetLocked = false;
      this.botCountLocked = false;
      this.winnerId = null;
      this.resetAt = null;
    }
  }

  private humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.isBot) n += 1;
    }
    return n;
  }

  private spawnBots(now: number): void {
    const desired = Math.min(this.botCount, MAX_PLAYERS - this.humanCount());
    let existing = 0;
    for (const p of this.players.values()) if (p.isBot) existing += 1;
    const toAdd = Math.max(0, desired - existing);
    for (let i = 0; i < toAdd; i++) {
      const id = `bot-${Math.random().toString(36).slice(2, 9)}`;
      const name = BOT.names[(existing + i) % BOT.names.length] ?? `Bot${i + 1}`;
      const bot = initialPlayer(id, id, name, randomSpawn(), now, {
        isBot: true,
        characterId: 'ch35',
      });
      ensureBotDefaults(bot, now);
      this.players.set(id, bot);
    }
  }

  private removeAllBots(): void {
    for (const [id, p] of this.players) {
      if (p.isBot) {
        this.players.delete(id);
        this.pendingFire.delete(id);
      }
    }
  }

  onError(_conn: Party.Connection, err: Error): void {
    console.error('connection error', err);
  }

  private runTick(): void {
    const now = this.serverTime();
    const all = Array.from(this.players.values());

    for (const p of all) {
      finishReload(p, now);
      maybeRespawn(p, now);
      regenHealth(p, now);
      // Vault tween (if any) drives position; must run before integrateIdle
      // since integrateIdle is no-op while vaulting and we want position fresh.
      tickVault(p, now);
    }

    // Bots produce input frames here, BEFORE integrateIdle so their applyInput
    // call updates lastIntegratedAt — otherwise integrateIdle would slap a
    // duplicate physics step on top of the controller's frame.
    if (this.winnerId === null) {
      const profile =
        BOT_PROFILES[this.botDifficulty] ?? BOT_PROFILES[MATCH.defaultBotDifficulty];
      for (const p of all) {
        if (!p.isBot) continue;
        const fired = tickBot(p, all, now, profile);
        if (fired) this.pendingFire.add(p.id);
      }
    }

    for (const p of all) {
      // Run physics for any time gap that hasn't already been integrated by an
      // arriving input — keeps idle/AFK/just-spawned players from floating.
      integrateIdle(p, now);
      // Stamp position into the rewind buffer AFTER all this tick's physics
      // is final, so the buffer reflects the same positions broadcast in the
      // upcoming snapshot. tryFire below uses these to rewind hit detection.
      pushPositionHistory(p, now);
    }

    if (this.winnerId === null && this.pendingFire.size > 0) {
      for (const id of this.pendingFire) {
        const shooter = this.players.get(id);
        if (!shooter) continue;
        const fired = tryFire(shooter, all, now);
        if (fired.length > 0) this.events.push(...fired);
      }
      this.pendingFire.clear();

      // Did anyone hit the kill target this tick? Pick the highest-scoring
      // player as the winner (ties broken by player insertion order).
      let winner: ServerPlayer | null = null;
      for (const p of all) {
        if (p.kills >= this.killTarget && (winner === null || p.kills > winner.kills)) {
          winner = p;
        }
      }
      if (winner) {
        this.winnerId = winner.id;
        this.resetAt = now + MATCH.victoryHoldMs;
        this.events.push({
          type: 'gameover',
          winnerId: winner.id,
          winnerName: winner.name,
          killTarget: this.killTarget,
          at: now,
        });
      }
    } else {
      this.pendingFire.clear();
    }

    if (this.resetAt !== null && now >= this.resetAt) {
      this.resetRound(now, all);
    }

    this.tick += 1;
  }

  private resetRound(now: number, all: ServerPlayer[]): void {
    for (const p of all) {
      p.kills = 0;
      p.deaths = 0;
      p.health = PLAYER.maxHealth;
      p.alive = true;
      p.respawnAt = null;
      p.position = randomSpawn();
      p.velocity = [0, 0, 0];
      p.ammo = WEAPON.magazineSize;
      p.reloading = false;
      p.reloadDoneAt = null;
      p.lastDamagedAt = 0;
      p.lastIntegratedAt = now;
      p.grounded = true;
      if (p.isBot) ensureBotDefaults(p, now);
    }
    this.winnerId = null;
    this.resetAt = null;
  }

  private broadcastSnapshot(): void {
    if (this.players.size === 0) return;

    const snapshot: GameSnapshot = {
      serverTime: this.serverTime(),
      tick: this.tick,
      players: Array.from(this.players.values()).map(stripServerOnly),
      killTarget: this.killTarget,
      winnerId: this.winnerId,
    };
    this.room.broadcast(encode<ServerMessage>({ type: 'snapshot', snapshot }));

    if (this.events.length > 0) {
      this.room.broadcast(encode<ServerMessage>({ type: 'events', events: this.events }));
      this.events = [];
    }
  }

  private send(conn: Party.Connection, msg: ServerMessage): void {
    conn.send(encode(msg));
  }

  private serverTime(): number {
    return Date.now() - this.startedAt;
  }

  private stopTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }
}

const stripServerOnly = (p: ServerPlayer) => ({
  id: p.id,
  name: p.name,
  position: p.position,
  velocity: p.velocity,
  yaw: p.yaw,
  pitch: p.pitch,
  health: p.health,
  alive: p.alive,
  respawnAt: p.respawnAt,
  ammo: p.ammo,
  reloading: p.reloading,
  reloadDoneAt: p.reloadDoneAt,
  vaulting: p.vaulting,
  kills: p.kills,
  deaths: p.deaths,
  lastSeenSeq: p.lastSeenSeq,
  isBot: p.isBot,
  characterId: p.characterId,
});
