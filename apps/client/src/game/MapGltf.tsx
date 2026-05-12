import { useGLTF } from '@react-three/drei';
import { MAPS, type MapId } from '@slipstream/shared';

const URLS: Partial<Record<MapId, string>> = {
  fps_shooter: '/maps/fps_shooter/scene.gltf',
};

for (const url of Object.values(URLS)) {
  if (url) useGLTF.preload(url);
}

// Per-map scale applied to the rendered GLTF. Must match the SCALE constant
// in scripts/extract-map-collision.mjs so collision and visuals line up.
const SCALE: Partial<Record<MapId, number>> = {
  fps_shooter: 1,
};

export const MapGltf = ({ id }: { id: MapId }) => {
  const url = URLS[id];
  if (!url) return null;
  const { scene } = useGLTF(url);
  const offset = MAPS[id].gltfOffset ?? [0, 0, 0];
  const scale = SCALE[id] ?? 1;
  return <primitive object={scene} position={offset} scale={scale} />;
};
