import type { GameEvent, GameSnapshot, PlayerId } from './state.js';
import type { Vec3 } from './state.js';

export interface InputFrame {
  seq: number;
  dtMs: number;
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
  reload: boolean;
  yaw: number;
  pitch: number;
  // Camera-resolved aim. Sent on every frame, but it's the per-fire-input
  // aim that matters: the server fires from `aimOrigin` toward `aim`, NOT
  // from the player's eye along yaw/pitch. Avoids the third-person camera-
  // vs-eye parallax bug where the camera (which sits behind+above the
  // player) sees over a ledge but the eye is occluded by it; reticle says
  // "clear shot" but the server saw a wall.
  //
  // Both null → server falls back to eye-from-yaw/pitch (older clients,
  // bots, or any frame the client couldn't compute a camera ray for).
  aimOrigin: Vec3 | null;
  aim: Vec3 | null;
}

export type ClientMessage =
  | { type: 'hello'; name: string }
  | { type: 'input'; frames: InputFrame[] }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | { type: 'welcome'; you: PlayerId; serverTime: number }
  | { type: 'snapshot'; snapshot: GameSnapshot }
  | { type: 'events'; events: GameEvent[] }
  | { type: 'pong'; t: number; serverTime: number };

export const encode = <T>(msg: T): string => JSON.stringify(msg);
export const decode = <T>(raw: string): T => JSON.parse(raw) as T;
