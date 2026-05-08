import type * as Party from 'partykit/server';
import {
  MAX_PLAYERS,
  SNAPSHOT_MS,
  TICK_MS,
  decode,
  encode,
  type ClientMessage,
  type GameEvent,
  type GameSnapshot,
  type ServerMessage,
} from '@slipstream/shared';
import { applyInput, finishReload, integrateIdle, maybeRespawn, tryFire } from './simulation.js';
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

  constructor(readonly room: Party.Room) {}

  onStart(): void {
    this.startedAt = Date.now();
    this.startTimers();
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    if (this.players.size >= MAX_PLAYERS) {
      conn.close(4001, 'room full');
      return;
    }
    const url = new URL(ctx.request.url);
    const name = (url.searchParams.get('name') ?? 'Player').slice(0, 24) || 'Player';
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
        for (const frame of msg.frames) {
          if (frame.seq <= player.lastSeenSeq) continue;
          // No firing while sprinting — silently demote sprint when fire is
          // pressed. Player walks-while-firing instead of running-while-firing.
          const effectiveFrame =
            frame.fire && frame.sprint ? { ...frame, sprint: false } : frame;
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
      // Run physics for any time gap that hasn't already been integrated by an
      // arriving input — keeps idle/AFK/just-spawned players from floating.
      integrateIdle(p, now);
    }

    if (this.pendingFire.size > 0) {
      for (const id of this.pendingFire) {
        const shooter = this.players.get(id);
        if (!shooter) continue;
        const fired = tryFire(shooter, all, now);
        if (fired.length > 0) this.events.push(...fired);
      }
      this.pendingFire.clear();
    }

    this.tick += 1;
  }

  private broadcastSnapshot(): void {
    if (this.players.size === 0) return;

    const snapshot: GameSnapshot = {
      serverTime: this.serverTime(),
      tick: this.tick,
      players: Array.from(this.players.values()).map(stripServerOnly),
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
