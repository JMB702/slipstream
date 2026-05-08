import { useAnimations, useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type AnimationAction,
} from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLAYER, type PlayerId, type Vec3 } from '@slipstream/shared';
import { useGame } from '../store.js';

// =============================================================================
// Mixamo rifle-aim character swap workflow
// =============================================================================
// Soldier.glb only ships Idle / Walk / Run / TPose with arms swinging freely
// — that's why a held weapon never looks right against it. The proper fix is
// to use a character animated with a held rifle:
//
//   1. https://www.mixamo.com (free Adobe login)
//   2. Pick a rigged character. Download as FBX Binary, with Skin, T-pose.
//      Most Mixamo characters DO NOT include a gun mesh — they expect you to
//      attach one to the right-hand bone. If you want a built-in gun, search
//      Sketchfab/CGTrader for a "Mixamo-rigged soldier with rifle" (or pose
//      one in Blender by attaching a gun mesh to mixamorigRightHand).
//   3. Pick rifle animations one at a time, download as FBX Binary, without
//      Skin, 30fps:
//        - "Rifle Idle"           -> "Idle"
//        - "Rifle Walk Forward"   -> "Walk"
//        - "Rifle Run"            -> "Run"
//        - "Firing Rifle"         -> "Fire"
//   4. In Blender: import character FBX, then each animation FBX. In the
//      Action Editor, rename actions to Idle / Walk / Run / Fire. Export as
//      glTF 2.0 with Animations enabled.
//   5. Replace apps/client/public/models/Soldier.glb with the new GLB.
//   6. If your clips use different names (Mixamo often suffixes them with
//      "mixamo.com" or the source-FBX name), update CLIP_NAMES below.
//
// What this file already supports:
//   - Idle / Walk / Run blending (locomotion state machine, looping clips)
//   - Jump fakery (freezes Run mid-stride; replace with a real Jump clip
//     if your pack has one and update CLIP_NAMES.Jump)
//   - Fire as a one-shot full-body override on shot events (gated on the
//     CLIP_NAMES.Fire entry — leave it null to disable while you don't have
//     a Fire clip yet)
// =============================================================================

const MODEL_URL = '/models/Soldier.glb';
useGLTF.preload(MODEL_URL);

interface Props {
  velocity: Vec3;
  alive: boolean;
  playerId: PlayerId | null;
}

const WALK_RUN_THRESHOLD = (PLAYER.walkSpeed + PLAYER.sprintSpeed) / 2;
const IDLE_SPEED = 0.15;
const AIRBORNE_VY = 0.5;

// Run clip is ~0.7s; mid-stride lands around 0.35s with one leg planted —
// reads as a leap silhouette when frozen. Used by Jump fallback.
const JUMP_POSE_TIME = 0.35;

// Fire animation duration (ms). After this elapses with no further shots,
// the character returns to locomotion. If you have a 0.4s Fire clip, set
// this slightly less so the next shot can re-trigger smoothly.
const FIRE_HOLD_MS = 350;

type ClipKey = 'Idle' | 'Walk' | 'Run' | 'Jump' | 'Fire';

// Map ClipKey -> the actual clip name in the GLB. `null` means "no clip
// available, skip transitions to this state". Most Mixamo character packs
// will need only the Fire entry filled in.
const CLIP_NAMES: Record<ClipKey, string | null> = {
  Idle: 'Idle',
  Walk: 'Walk',
  Run: 'Run',
  Jump: 'Run', // re-uses Run frozen mid-stride; replace with 'Jump' when a real clip lands
  Fire: 'Fire',
};

export const Character = ({ velocity, alive, playerId }: Props) => {
  const gltf = useGLTF(MODEL_URL);
  const cloned = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const { actions } = useAnimations(gltf.animations, cloned);
  const currentAnim = useRef<ClipKey>('Idle');

  // Fire state: true while we want to be playing the Fire clip. Cleared by
  // a timer FIRE_HOLD_MS after the most recent shot event for this player.
  const [firing, setFiring] = useState(false);
  const fireTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenEventsRef = useRef(0);

  useEffect(() => {
    return useGame.subscribe((state) => {
      if (!playerId) return;
      if (state.events.length === seenEventsRef.current) return;
      const fresh = state.events.slice(seenEventsRef.current);
      seenEventsRef.current = state.events.length;
      let firedThisBatch = false;
      for (const ev of fresh) {
        if (ev.type === 'shot' && ev.shooterId === playerId) firedThisBatch = true;
      }
      if (!firedThisBatch) return;
      setFiring(true);
      if (fireTimeoutRef.current) clearTimeout(fireTimeoutRef.current);
      fireTimeoutRef.current = setTimeout(() => setFiring(false), FIRE_HOLD_MS);
    });
  }, [playerId]);

  // Start the default (Idle) animation once actions are available.
  useEffect(() => {
    const idle = actions[CLIP_NAMES.Idle ?? ''];
    if (idle) idle.reset().fadeIn(0.15).play();
  }, [actions]);

  // Attach a rifle to the right-hand bone. With rifle-aim animations, the
  // hands are posed in a grip stance, so the rifle ends up looking held
  // (both hands near each other on the weapon).
  useEffect(() => {
    const bone = findRightHandBone(cloned);
    if (!bone) {
      console.warn('Character: no right-hand bone found, gun not attached');
      return;
    }
    const gun = createRifleMesh();
    gun.position.set(GUN_POS_X, GUN_POS_Y, GUN_POS_Z);
    gun.rotation.set(GUN_ROT_X, GUN_ROT_Y, GUN_ROT_Z);
    bone.add(gun);
    return () => {
      bone.remove(gun);
      gun.traverse((obj) => {
        if (obj instanceof Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof MeshStandardMaterial) obj.material.dispose();
        }
      });
    };
  }, [cloned]);

  // State machine. Acts only on actual transitions.
  useEffect(() => {
    if (!alive) {
      for (const a of Object.values(actions)) a?.fadeOut(0.2);
      return;
    }

    const speed = Math.hypot(velocity[0], velocity[2]);
    const airborne = Math.abs(velocity[1]) > AIRBORNE_VY;
    const fireClip = CLIP_NAMES.Fire ? actions[CLIP_NAMES.Fire] : undefined;

    // Fire takes priority over locomotion (and Jump) when a clip is available
    // AND we're not airborne (jumping with a fire animation looks worse than
    // letting Jump play).
    const wanted: ClipKey =
      firing && fireClip && !airborne
        ? 'Fire'
        : airborne
          ? 'Jump'
          : speed < IDLE_SPEED
            ? 'Idle'
            : speed < WALK_RUN_THRESHOLD
              ? 'Walk'
              : 'Run';

    if (currentAnim.current === wanted) return;

    const prev = pickAction(actions, currentAnim.current);
    const next = pickAction(actions, wanted);
    const sameClip = prev === next;

    if (sameClip && next) {
      applyClipMode(next, wanted, false);
      next.play();
      currentAnim.current = wanted;
      return;
    }

    if (prev) prev.fadeOut(0.15);
    if (next) {
      applyClipMode(next, wanted, true);
      next.fadeIn(0.15).play();
    }
    currentAnim.current = wanted;
  }, [velocity, alive, firing, actions]);

  if (!alive) return null;

  // Soldier.glb origin is at the feet; our player position is the capsule
  // center, so push the model down by half-height. The model's local forward
  // is already -z (matching our world's forward at yaw=0).
  return (
    <group position={[0, -PLAYER.height / 2, 0]}>
      <primitive object={cloned} />
    </group>
  );
};

const pickAction = (
  actions: Record<string, AnimationAction | null>,
  key: ClipKey,
): AnimationAction | undefined => {
  const name = CLIP_NAMES[key];
  if (!name) return undefined;
  return actions[name] ?? undefined;
};

// Configures an action for the given state. `freshClip` is true when the
// action's clip is changing (e.g., Idle → Jump) and we want to start the
// leap pose at a known frame; false when the same clip is being re-used
// (Run ↔ Jump) and we want to leave the cycle's playhead alone.
const applyClipMode = (
  action: AnimationAction,
  mode: ClipKey,
  freshClip: boolean,
): void => {
  // CRITICAL: three.js automatically sets enabled=false when a fadeOut
  // completes. fadeIn doesn't re-enable, so the mixer would force the
  // action's effective weight to 0 (the bind / T-pose blends through).
  action.enabled = true;

  if (mode === 'Jump') {
    if (freshClip) action.time = JUMP_POSE_TIME;
    action.paused = true;
    action.timeScale = 0;
    return;
  }

  action.paused = false;
  action.timeScale = 1;
  if (mode === 'Fire' && freshClip) {
    // Restart the fire clip from the beginning so each shot replays cleanly.
    action.time = 0;
  }
};

// =============================================================================
// Rifle attached to the right-hand bone. Tunable offsets — Mixamo's right-hand
// bone has its local axes oriented along the fingers, so the rifle needs to
// rotate to align with the grip direction. Adjust if the rifle floats off-hand.
// =============================================================================
const GUN_POS_X = 0;
const GUN_POS_Y = 0.04;
const GUN_POS_Z = 0.12;
const GUN_ROT_X = 0;
const GUN_ROT_Y = Math.PI / 2;
const GUN_ROT_Z = 0;

const findRightHandBone = (root: Object3D): Object3D | null => {
  let best: Object3D | null = null;
  root.traverse((obj) => {
    if (best) return;
    const name = obj.name;
    const lower = name.toLowerCase();
    if (
      name === 'mixamorigRightHand' ||
      name === 'RightHand' ||
      name === 'Hand_R' ||
      name === 'hand_r' ||
      (lower.includes('hand') &&
        (lower.includes('right') || lower.endsWith('_r') || lower.endsWith('.r')))
    ) {
      best = obj;
    }
  });
  return best;
};

// Two-handed rifle. Local origin sits at the pistol-grip — that's where the
// dominant hand goes, so attaching to the right-hand bone places the grip
// in the hand naturally.
const createRifleMesh = (): Group => {
  const gun = new Group();

  const metal = new MeshStandardMaterial({ color: '#1a1a1a', metalness: 0.7, roughness: 0.35 });
  const wood = new MeshStandardMaterial({ color: '#3a2818', metalness: 0.05, roughness: 0.85 });

  // Receiver — main body, sits forward of the grip
  const receiver = new Mesh(new BoxGeometry(0.06, 0.08, 0.3), metal);
  receiver.position.set(0, 0.07, -0.05);
  receiver.castShadow = true;
  gun.add(receiver);

  // Barrel — extends forward (-z) from the front of the receiver
  const barrel = new Mesh(new CylinderGeometry(0.014, 0.014, 0.4, 12), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.09, -0.4);
  barrel.castShadow = true;
  gun.add(barrel);

  // Stock — extends backward (+z) from the receiver
  const stock = new Mesh(new BoxGeometry(0.05, 0.08, 0.22), wood);
  stock.position.set(0, 0.06, 0.21);
  stock.castShadow = true;
  gun.add(stock);

  // Pistol grip — directly at the gun's local origin (where the hand bone holds it)
  const grip = new Mesh(new BoxGeometry(0.04, 0.11, 0.05), wood);
  grip.position.set(0, 0, 0);
  grip.rotation.x = -0.18;
  grip.castShadow = true;
  gun.add(grip);

  // Forend — under the barrel, support-hand grip
  const forend = new Mesh(new BoxGeometry(0.05, 0.04, 0.18), wood);
  forend.position.set(0, 0.05, -0.22);
  forend.castShadow = true;
  gun.add(forend);

  // Iron sight
  const sight = new Mesh(new BoxGeometry(0.012, 0.025, 0.02), metal);
  sight.position.set(0, 0.13, -0.1);
  gun.add(sight);

  return gun;
};
