import { create } from 'zustand';
import {
  DEFAULT_MAP_ID,
  MATCH,
  type GameEvent,
  type GameSnapshot,
  type MapId,
  type PlayerId,
  type PlayerState,
} from '@slipstream/shared';

export type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface SnapshotEntry {
  receivedAt: number;
  serverTime: number;
  players: Map<PlayerId, PlayerState>;
}

interface State {
  conn: ConnState;
  myId: PlayerId | null;
  serverTimeOffset: number;
  snapshots: SnapshotEntry[];
  events: GameEvent[];
  killFeed: GameEvent[];
  chat: GameEvent[];
  killTarget: number;
  winnerId: PlayerId | null;
  activeMapId: MapId;
  // Reason from the most recent socket close, surfaced in the Lobby.
  // Cleared when the user starts another join attempt.
  lastCloseReason: string | null;
  setConn(s: ConnState): void;
  setCloseReason(r: string | null): void;
  setMyId(id: PlayerId): void;
  setActiveMapId(id: MapId): void;
  ingestSnapshot(s: GameSnapshot): void;
  ingestEvents(e: GameEvent[]): void;
  reset(): void;
}

const SNAPSHOT_BUFFER = 30;
const FEED_LIMIT = 8;

// Dev-only debug hook: expose the store on window so test scripts and
// in-browser eval can read live snapshot/player state without needing the
// same module instance Vite served to the app. Stripped in production
// builds via `import.meta.env.DEV`.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Promise.resolve().then(() => {
    (window as unknown as { useGame: unknown }).useGame = useGame;
  });
}

export const useGame = create<State>((set, get) => ({
  conn: 'idle',
  myId: null,
  serverTimeOffset: 0,
  snapshots: [],
  events: [],
  killFeed: [],
  chat: [],
  killTarget: MATCH.defaultKillTarget,
  winnerId: null,
  activeMapId: DEFAULT_MAP_ID,
  lastCloseReason: null,

  setConn(s) {
    set({ conn: s });
  },

  setCloseReason(r) {
    set({ lastCloseReason: r });
  },

  setMyId(id) {
    set({ myId: id });
  },

  setActiveMapId(id) {
    set({ activeMapId: id });
  },

  ingestSnapshot(s) {
    const map = new Map<PlayerId, PlayerState>();
    for (const p of s.players) map.set(p.id, p);
    const entry: SnapshotEntry = {
      receivedAt: performance.now(),
      serverTime: s.serverTime,
      players: map,
    };
    const snapshots = [...get().snapshots, entry];
    while (snapshots.length > SNAPSHOT_BUFFER) snapshots.shift();
    set({ snapshots, killTarget: s.killTarget, winnerId: s.winnerId });
  },

  ingestEvents(events) {
    const prev = get();
    const kills = events.filter((e) => e.type === 'kill');
    const chats = events.filter((e) => e.type === 'chat');
    set({
      events: [...prev.events, ...events].slice(-200),
      killFeed: [...prev.killFeed, ...kills].slice(-FEED_LIMIT),
      chat: [...prev.chat, ...chats].slice(-FEED_LIMIT),
    });
  },

  reset() {
    set({
      conn: 'idle',
      myId: null,
      serverTimeOffset: 0,
      snapshots: [],
      events: [],
      killFeed: [],
      chat: [],
      killTarget: MATCH.defaultKillTarget,
      winnerId: null,
      lastCloseReason: null,
    });
  },
}));

export const latestPlayers = (): Map<PlayerId, PlayerState> => {
  const snaps = useGame.getState().snapshots;
  const last = snaps[snaps.length - 1];
  return last ? last.players : new Map();
};
