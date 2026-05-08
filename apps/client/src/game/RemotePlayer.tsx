import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Group } from 'three';
import { NET, type PlayerId, type PlayerState, type Vec3 } from '@slipstream/shared';
import { useGame } from '../store.js';
import { PlayerModel } from './PlayerModel.js';

interface Props {
  id: PlayerId;
}

export const RemotePlayer = ({ id }: Props) => {
  const ref = useRef<Group>(null);
  const renderState = useRef<{
    name: string;
    alive: boolean;
    health: number;
    velocity: Vec3;
  }>({
    name: '',
    alive: true,
    health: 100,
    velocity: [0, 0, 0],
  });

  useFrame(() => {
    const snaps = useGame.getState().snapshots;
    if (snaps.length === 0 || !ref.current) return;

    const newest = snaps[snaps.length - 1];
    if (!newest) return;
    const renderTime = newest.serverTime - NET.interpolationDelayMs;

    let from = snaps[0]!;
    let to = newest;
    for (let i = 0; i < snaps.length - 1; i++) {
      const s0 = snaps[i];
      const s1 = snaps[i + 1];
      if (!s0 || !s1) continue;
      if (s0.serverTime <= renderTime && s1.serverTime >= renderTime) {
        from = s0;
        to = s1;
        break;
      }
    }

    const a = from.players.get(id);
    const b = to.players.get(id);
    const target = b ?? a;
    if (!target) return;

    const span = Math.max(1, to.serverTime - from.serverTime);
    const t = clamp((renderTime - from.serverTime) / span, 0, 1);

    const ax = a?.position[0] ?? target.position[0];
    const ay = a?.position[1] ?? target.position[1];
    const az = a?.position[2] ?? target.position[2];
    const bx = target.position[0];
    const by = target.position[1];
    const bz = target.position[2];

    ref.current.position.set(lerp(ax, bx, t), lerp(ay, by, t), lerp(az, bz, t));
    ref.current.rotation.y = lerpAngle(a?.yaw ?? target.yaw, target.yaw, t);

    renderState.current.name = target.name;
    renderState.current.alive = target.alive;
    renderState.current.health = target.health;
    renderState.current.velocity = target.velocity;
  });

  const initialName = useMemo(() => latestName(id), [id]);

  return (
    <group ref={ref}>
      <PlayerModel
        name={renderState.current.name || initialName}
        alive={renderState.current.alive}
        health={renderState.current.health}
        velocity={renderState.current.velocity}
        playerId={id}
      />
    </group>
  );
};

const latestName = (id: PlayerId): string => {
  const snaps = useGame.getState().snapshots;
  for (let i = snaps.length - 1; i >= 0; i--) {
    const snap = snaps[i];
    if (!snap) continue;
    const p: PlayerState | undefined = snap.players.get(id);
    if (p) return p.name;
  }
  return 'Player';
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const lerpAngle = (a: number, b: number, t: number) => {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
