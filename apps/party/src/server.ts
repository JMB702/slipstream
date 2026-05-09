import type * as Party from 'partykit/server';
import {
  MATCH,
  MAX_PLAYERS,
  PLAYER,
  SNAPSHOT_MS,
  TICK_MS,
  WEAPON,
  decode,
  encode,
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
  regenHealth,
  tryFire,
} from './simulation.js';
import { initialPlayer, randomSpawn, type ServerPlayer } from './state.js';

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
  private winnerId: string | null = null;
  private resetAt: number | null = null;

  constructor(readonly room: Party.Room) {}

  onStart(): void {
    this.startedAt = Date.now();
    this.startTimers();
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    const url = new URL(ctx.request.url);

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
    const player = initialPlayer(conn.id, conn.id, name, randomSpawn(), this.serverTime());
    this.players.set(conn.id, player);

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
    if (this.players.size === 0) {
      this.stopTimers();
      // Empty room — release the killTarget lock so the next first-joiner
      // can pick a new target.
      this.killTargetLocked = false;
      this.winnerId = null;
      this.resetAt = null;
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
      // Run physics for any time gap that hasn't already been integrated by an
      // arriving input — keeps idle/AFK/just-spawned players from floating.
      integrateIdle(p, now);
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
  kills: p.kills,
  deaths: p.deaths,
  lastSeenSeq: p.lastSeenSeq,
});
