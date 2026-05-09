import { Billboard, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { Suspense, useState } from 'react';
import { PLAYER, type CharacterId, type PlayerId, type Vec3 } from '@slipstream/shared';
import { Character } from './Character.js';
import { getLastAimedAt } from './aim-state.js';
import { useGame } from '../store.js';

// How long an enemy's nameplate stays visible after the local reticle leaves
// them. Matches the spec: tag on aim, fade out after a 3s grace.
const NAME_REVEAL_HOLD_MS = 3000;

interface Props {
  name: string;
  alive: boolean;
  health: number;
  velocity: Vec3;
  yaw: number;
  reloading: boolean;
  vaulting: boolean;
  playerId: PlayerId | null;
  isBot?: boolean;
  characterId?: CharacterId;
}

export const PlayerModel = ({
  name,
  alive,
  health,
  velocity,
  yaw,
  reloading,
  vaulting,
  playerId,
  isBot,
  characterId,
}: Props) => {
  const myId = useGame((s) => s.myId);
  const isSelf = playerId !== null && playerId === myId;
  const showsName = alive && playerId !== null && !isSelf;
  return (
    <group>
      <Suspense fallback={<CapsuleFallback />}>
        <Character
          velocity={velocity}
          yaw={yaw}
          reloading={reloading}
          vaulting={vaulting}
          alive={alive}
          playerId={playerId}
          characterId={characterId}
        />
      </Suspense>
      {alive && (
        <Billboard position={[0, PLAYER.height / 2 + 0.35, 0]}>
          {showsName && <EnemyNameLabel name={isBot ? `BOT ${name}` : name} playerId={playerId} />}
          {health < PLAYER.maxHealth && <NameplateHealthBar health={health} />}
        </Billboard>
      )}
    </group>
  );
};

// Reveals the enemy's name on aim, holds it for NAME_REVEAL_HOLD_MS after the
// local reticle leaves them. Edge-detected re-render so we don't pay React
// reconciliation cost every frame — only when visibility actually flips.
const EnemyNameLabel = ({ name, playerId }: { name: string; playerId: PlayerId }) => {
  const [visible, setVisible] = useState(false);
  useFrame(() => {
    const last = getLastAimedAt(playerId);
    const should = last > 0 && performance.now() - last < NAME_REVEAL_HOLD_MS;
    if (should !== visible) setVisible(should);
  });
  if (!visible) return null;
  return (
    <Text fontSize={0.14} color="white" outlineWidth={0.012} outlineColor="black">
      {name}
    </Text>
  );
};

const NAMEPLATE_BAR_W = 0.9;
const NAMEPLATE_BAR_H = 0.04;

const NameplateHealthBar = ({ health }: { health: number }) => {
  const frac = Math.max(0, Math.min(1, health / PLAYER.maxHealth));
  const fillW = Math.max(0.0001, NAMEPLATE_BAR_W * frac);
  const fillX = -NAMEPLATE_BAR_W / 2 + fillW / 2;
  const color = frac > 0.6 ? '#5fff8f' : frac > 0.3 ? '#ffd060' : '#ff5050';
  return (
    <group position={[0, -0.16, 0]}>
      <mesh>
        <planeGeometry args={[NAMEPLATE_BAR_W + 0.03, NAMEPLATE_BAR_H + 0.03]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.7} />
      </mesh>
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[NAMEPLATE_BAR_W, NAMEPLATE_BAR_H]} />
        <meshBasicMaterial color="#3a0a0a" />
      </mesh>
      <mesh position={[fillX, 0, 0.002]}>
        <planeGeometry args={[fillW, NAMEPLATE_BAR_H]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
};

// Shown while the GLB is fetching/parsing on first mount.
const CapsuleFallback = () => (
  <mesh castShadow>
    <capsuleGeometry args={[PLAYER.radius, PLAYER.height - PLAYER.radius * 2, 8, 16]} />
    <meshStandardMaterial color="#666" />
  </mesh>
);

export const colorForId = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 70%, 55%)`;
};
