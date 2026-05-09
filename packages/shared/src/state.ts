export type PlayerId = string;

export type Vec3 = readonly [number, number, number];

export type CharacterId = 'soldier' | 'ch35';

export interface PlayerState {
  id: PlayerId;
  name: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  respawnAt: number | null;
  ammo: number;
  reloading: boolean;
  reloadDoneAt: number | null;
  vaulting: boolean;
  kills: number;
  deaths: number;
  lastSeenSeq: number;
  isBot: boolean;
  characterId: CharacterId;
}

export interface GameSnapshot {
  serverTime: number;
  tick: number;
  players: PlayerState[];
  killTarget: number;
  // When set, the room is in the post-victory freeze before auto-reset.
  // Client uses this to render the victory overlay.
  winnerId: PlayerId | null;
}

export interface KillEvent {
  type: 'kill';
  killerId: PlayerId | null;
  victimId: PlayerId;
  at: number;
}

export interface ShotEvent {
  type: 'shot';
  shooterId: PlayerId;
  origin: Vec3;
  direction: Vec3;
  hit: PlayerId | null;
  at: number;
}

export interface ChatEvent {
  type: 'chat';
  fromId: PlayerId;
  fromName: string;
  text: string;
  at: number;
}

export interface GameOverEvent {
  type: 'gameover';
  winnerId: PlayerId;
  winnerName: string;
  killTarget: number;
  at: number;
}

export type GameEvent = KillEvent | ShotEvent | ChatEvent | GameOverEvent;
