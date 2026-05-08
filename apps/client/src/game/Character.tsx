import { useAnimations, useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import { type AnimationAction } from 'three';
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

type ClipKey = 'Idle' | 'Walk' | 'Run' | 'Jump';

export const Character = ({ velocity, alive }: Props) => {
  const gltf = useGLTF(MODEL_URL);
  // Drei's useGLTF returns a shared scene; clone for multi-instance use so
  // each character animates its own skeleton. Pass the cloned scene directly
  // to useAnimations so the mixer attaches to the object that actually
  // contains the bones (passing an outer wrapper ref relies on tree traversal
  // and has been a source of intermittent bind issues).
  const cloned = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const { actions } = useAnimations(gltf.animations, cloned);
  const currentAnim = useRef<ClipKey>('Idle');

  // Soldier.glb ships with clip names "Idle", "Walk", "Run", "TPose" — no
  // dedicated Jump clip. Until a real one is sourced (Mixamo's Jump_Up /
  // Jump_Loop / Jump_Down combined into a GLB) we fake it by freezing the
  // Run animation at a mid-stride pose, which reads as a leap silhouette.
  // To swap in a real jump: add the clip to the GLB, name it "Jump",
  // remove the freeze code path below, and restore Jump → Jump in clipNames.
  const clipNames = useMemo<Record<ClipKey, string>>(
    () => ({ Idle: 'Idle', Walk: 'Walk', Run: 'Run', Jump: 'Run' }),
    [],
  );

  // Start the default (Idle) animation once actions are available. Stable
  // deps in practice — drei keeps the actions object identity steady — so
  // this runs once per mount.
  useEffect(() => {
    const idle = actions[clipNames.Idle];
    if (idle) idle.reset().fadeIn(0.15).play();
  }, [actions, clipNames]);

  // State machine. ONLY acts on actual transitions — no defensive isRunning
  // check, because that misfires for paused actions (Jump's frozen pose),
  // continuously resetting weight to 0 via fadeIn and producing the bind
  // pose (T-pose) blend.
  useEffect(() => {
    if (!alive) {
      for (const a of Object.values(actions)) a?.fadeOut(0.2);
      return;
    }

    const speed = Math.hypot(velocity[0], velocity[2]);
    const airborne = Math.abs(velocity[1]) > AIRBORNE_VY;
    const wanted: ClipKey = airborne
      ? 'Jump'
      : speed < IDLE_SPEED
        ? 'Idle'
        : speed < WALK_RUN_THRESHOLD
          ? 'Walk'
          : 'Run';

    if (currentAnim.current === wanted) return;

    const prev = actions[clipNames[currentAnim.current]];
    const next = actions[clipNames[wanted]];
    const sameClip = prev === next;

    if (sameClip && next) {
      // Same underlying clip (Run ↔ Jump) — toggle freeze state in place.
      // No reset, no fade: action keeps its weight (1) and continues from
      // where it was paused.
      applyClipMode(next, wanted, /* freshClip */ false);
      next.play();
      currentAnim.current = wanted;
      return;
    }

    if (prev) prev.fadeOut(0.15);
    if (next) {
      applyClipMode(next, wanted, /* freshClip */ true);
      next.fadeIn(0.15).play();
    }
    currentAnim.current = wanted;
  }, [velocity, alive, actions, clipNames]);

  if (!alive) return null;

  // Soldier.glb origin is at the feet; our player position is the capsule
  // center, so push the model down by half-height. The model's local forward
  // is already -z (matching our world's forward at yaw=0), so no extra
  // rotation needed.
  return (
    <group position={[0, -PLAYER.height / 2, 0]}>
      <primitive object={cloned} />
    </group>
  );
};

// Run clip is ~0.7s; mid-stride lands around 0.35s with one leg planted —
// reads as a leap silhouette when frozen.
const JUMP_POSE_TIME = 0.35;

// Configures an action for the given state. `freshClip` is true when the
// action's clip is changing (e.g., Idle → Jump) and we want to start the
// leap pose at a known frame; false when the same clip is being re-used
// (Run ↔ Jump) and we want to leave the cycle's playhead alone to avoid
// a visible time-snap.
const applyClipMode = (
  action: AnimationAction,
  mode: ClipKey,
  freshClip: boolean,
): void => {
  if (mode === 'Jump') {
    if (freshClip) action.time = JUMP_POSE_TIME;
    action.paused = true;
    action.timeScale = 0;
  } else {
    action.paused = false;
    action.timeScale = 1;
  }
};
