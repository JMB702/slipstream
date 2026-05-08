import { HOUSE_WALLS, MAP, SCATTERED_OBSTACLES, type Obstacle } from '@slipstream/shared';

const renderObstacle = (o: Obstacle, key: number, color: string) => (
  <mesh
    key={key}
    position={o.pos as unknown as [number, number, number]}
    castShadow
    receiveShadow
  >
    <boxGeometry args={[o.halfSize[0] * 2, o.halfSize[1] * 2, o.halfSize[2] * 2]} />
    <meshStandardMaterial color={color} />
  </mesh>
);

export const Arena = () => {
  const half = MAP.size / 2;

  return (
    <group>
      <mesh receiveShadow position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MAP.size, MAP.size]} />
        <meshStandardMaterial color="#1a1f2e" />
      </mesh>

      {/* Map perimeter walls */}
      {([
        [half, 2, 0, 1, 4, MAP.size],
        [-half, 2, 0, 1, 4, MAP.size],
        [0, 2, half, MAP.size, 4, 1],
        [0, 2, -half, MAP.size, 4, 1],
      ] as const).map(([x, y, z, sx, sy, sz], i) => (
        <mesh key={i} position={[x, y, z]} castShadow receiveShadow>
          <boxGeometry args={[sx, sy, sz]} />
          <meshStandardMaterial color="#2a2f3e" />
        </mesh>
      ))}

      {/* House — tan walls so the structure reads against the floor */}
      {HOUSE_WALLS.map((o, i) => renderObstacle(o, i, '#8a7a5c'))}

      {/* Scattered cover */}
      {SCATTERED_OBSTACLES.map((o, i) => renderObstacle(o, i, '#3a4055'))}

      <gridHelper args={[MAP.size, MAP.size, '#2a3050', '#1a2030']} position={[0, 0.01, 0]} />
    </group>
  );
};
