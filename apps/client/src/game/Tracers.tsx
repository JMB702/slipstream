import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import { useGame } from '../store.js';
import { WEAPON, type ShotEvent, type PlayerId } from '@slipstream/shared';

interface ActiveTracer {
  id: number;
  points: [[number, number, number], [number, number, number]];
  bornAt: number;
  hitId: PlayerId | null;
  hitPoint: [number, number, number] | null;
}

const TRACER_LIFE_MS = 250;
const FLASH_LIFE_MS = 350;

export const Tracers = () => {
  const [tracers, setTracers] = useState<ActiveTracer[]>([]);
  const idRef = useRef(0);
  const seenRef = useRef(0);

  useEffect(() => {
    return useGame.subscribe((state) => {
      if (state.events.length === seenRef.current) return;
      const fresh = state.events.slice(seenRef.current);
      seenRef.current = state.events.length;
      const shots = fresh.filter((e): e is ShotEvent => e.type === 'shot');
      if (shots.length === 0) return;
      setTracers((cur) => {
        const next = [...cur];
        for (const s of shots) {
          const len = WEAPON.range;
          const end: [number, number, number] = [
            s.origin[0] + s.direction[0] * len,
            s.origin[1] + s.direction[1] * len,
            s.origin[2] + s.direction[2] * len,
          ];
          next.push({
            id: idRef.current++,
            points: [[s.origin[0], s.origin[1], s.origin[2]], end],
            bornAt: performance.now(),
            hitId: s.hit,
            hitPoint: s.hit ? findHitPoint(s, end) : null,
          });
        }
        return next.slice(-32);
      });
    });
  }, []);

  useFrame(() => {
    const now = performance.now();
    setTracers((cur) => {
      const filtered = cur.filter((t) => now - t.bornAt < FLASH_LIFE_MS);
      return filtered.length === cur.length ? cur : filtered;
    });
  });

  const now = performance.now();

  return (
    <group>
      {tracers.map((t) => {
        const age = now - t.bornAt;
        const beamAlive = age < TRACER_LIFE_MS;
        const flashAlive = age < FLASH_LIFE_MS;
        const beamOpacity = beamAlive ? 1 - age / TRACER_LIFE_MS : 0;
        const flashScale = 0.25 + (age / FLASH_LIFE_MS) * 0.4;
        return (
          <group key={t.id}>
            {beamAlive && (
              <Line
                points={t.points}
                color="#ffe080"
                lineWidth={3}
                transparent
                opacity={beamOpacity}
              />
            )}
            <mesh position={t.points[0]}>
              <sphereGeometry args={[0.12, 8, 8]} />
              <meshBasicMaterial color="#fff5c0" transparent opacity={beamOpacity * 0.9} />
            </mesh>
            {t.hitPoint && flashAlive && (
              <mesh position={t.hitPoint}>
                <sphereGeometry args={[flashScale, 12, 12]} />
                <meshBasicMaterial color="#ff7050" transparent opacity={1 - age / FLASH_LIFE_MS} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
};

const findHitPoint = (
  s: ShotEvent,
  end: [number, number, number],
): [number, number, number] => {
  // Approximate: client doesn't have authoritative hit distance,
  // so use the snapshot position of the hit player if available.
  const lastSnap = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
  const hit = s.hit ? lastSnap?.players.get(s.hit) : null;
  if (hit) return [hit.position[0], hit.position[1] + 0.9, hit.position[2]];
  return end;
};
