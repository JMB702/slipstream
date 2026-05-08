import { useAnimations, useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import { Group } from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLAYER, type Vec3 } from '@slipstream/shared';

const MODEL_URL = '/models/Soldier.glb';

// Trigger the fetch as soon as the bundle loads so the first character mount
// doesn't have to wait on the network.
useGLTF.preload(MODEL_URL);

interface Props {
  velocity: Vec3;
  alive: boolean;
}

const WALK_RUN_THRESHOLD = (PLAYER.walkSpeed + PLAYER.sprintSpeed) / 2;
const IDLE_SPEED = 0.15;
const AIRBORNE_VY = 0.5; // |velocity.y| above this counts as airborne

type ClipKey = 'Idle' | 'Walk' | 'Run';

export const Character = ({ velocity, alive }: Props) => {
  const groupRef = useRef<Group>(null);
  const gltf = useGLTF(MODEL_URL);
  // Drei's useGLTF returns a shared scene; clone for multi-instance use so
  // each character animates its own skeleton.
  const cloned = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const { actions } = useAnimations(gltf.animations, groupRef);
  const currentAnim = useRef<ClipKey>('Idle');

  // Soldier.glb ships with clip names "Idle", "Walk", "Run", "TPose". Mixamo
  // GLBs typically use "mixamo.com" or the source-file name — inspect with
  // GLTFLoader().load(...).animations to discover the names of any new model.
  const clipNames = useMemo<Record<ClipKey, string>>(
    () => ({ Idle: 'Idle', Walk: 'Walk', Run: 'Run' }),
    [],
  );

  // Single effect drives the animation state machine. Picking the right clip
  // and ensuring it's actually running both happen here, so a re-create of
  // the `actions` object can't leave a previously-played action stopped with
  // no one to restart it.
  useEffect(() => {
    if (!alive) {
      for (const a of Object.values(actions)) a?.fadeOut(0.2);
      return;
    }

    const speed = Math.hypot(velocity[0], velocity[2]);
    const airborne = Math.abs(velocity[1]) > AIRBORNE_VY;
    const wanted: ClipKey = airborne
      ? 'Idle' // No jump clip in Soldier.glb — freeze on idle during airtime
      : speed < IDLE_SPEED
        ? 'Idle'
        : speed < WALK_RUN_THRESHOLD
          ? 'Walk'
          : 'Run';

    const next = actions[clipNames[wanted]];

    if (currentAnim.current === wanted) {
      // Defensive: if something stopped this action (e.g. the actions object
      // was rebuilt), make sure it's playing.
      if (next && !next.isRunning()) next.reset().fadeIn(0.15).play();
      return;
    }

    const prev = actions[clipNames[currentAnim.current]];
    if (prev) prev.fadeOut(0.15);
    if (next) next.reset().fadeIn(0.15).play();
    currentAnim.current = wanted;
  }, [velocity, alive, actions, clipNames]);

  if (!alive) return null;

  // Soldier.glb origin is at the feet; our player position is the capsule
  // center, so push the model down by half-height. The model's local forward
  // is already -z (matching our world's forward at yaw=0), so no extra
  // rotation needed.
  return (
    <group ref={groupRef} position={[0, -PLAYER.height / 2, 0]}>
      <primitive object={cloned} />
    </group>
  );
};
