import { Billboard, Text } from '@react-three/drei';
import { Suspense } from 'react';
import { PLAYER, type PlayerId, type Vec3 } from '@slipstream/shared';
import { Character } from './Character.js';

interface Props {
  name: string;
  alive: boolean;
  health: number;
  velocity: Vec3;
  playerId: PlayerId | null;
}

export const PlayerModel = ({ name, alive, health, velocity, playerId }: Props) => {
  if (!alive) return null;
  return (
    <group>
      <Suspense fallback={<CapsuleFallback />}>
        <Character velocity={velocity} alive={alive} playerId={playerId} />
      </Suspense>
      <Billboard position={[0, PLAYER.height / 2 + 0.4, 0]}>
        <Text fontSize={0.25} color="white" outlineWidth={0.02} outlineColor="black">
          {name}
        </Text>
        <Text
          position={[0, -0.3, 0]}
          fontSize={0.18}
          color="#90ff90"
          outlineWidth={0.015}
          outlineColor="black"
        >
          {`${Math.max(0, Math.round(health))} HP`}
        </Text>
      </Billboard>
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
