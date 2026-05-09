import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AnimationClip,
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type AnimationAction,
} from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLAYER, type CharacterId, type PlayerId, type Vec3 } from '@slipstream/shared';
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

const MODEL_URLS: Record<CharacterId, string> = {
  soldier: '/models/Soldier.glb',
  ch35: '/models/Ch35.glb',
};
for (const url of Object.values(MODEL_URLS)) useGLTF.preload(url);

interface Props {
  velocity: Vec3;
  yaw: number;
  reloading: boolean;
  vaulting: boolean;
  alive: boolean;
  playerId: PlayerId | null;
  characterId?: CharacterId;
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

// Muzzle flash visibility duration per shot (ms). Flash is meant to "pop" —
// shorter than FIRE_HOLD_MS, which spans the firing animation.
const MUZZLE_FLASH_MS = 55;

type Dir = 'F' | 'FR' | 'R' | 'BR' | 'B' | 'BL' | 'L' | 'FL';
type ClipKey =
  | 'Idle'
  | 'Jump'
  | 'Vault'
  | 'Death'
  | 'Fire'
  | 'FireWalk'
  | 'Reload'
  | 'ReloadWalk'
  | 'ReloadRun'
  | `Walk${Dir}`
  | `Run${Dir}`;

// Map ClipKey -> the actual clip name in the GLB. `null` means "no clip
// available, skip transitions to this state".
const CLIP_NAMES: Record<ClipKey, string | null> = {
  Idle: 'Idle',
  Jump: 'RunF', // re-uses sprint-forward frozen mid-stride; replace with a real Jump clip later
  Vault: 'Vault',
  Death: 'Death',
  Fire: 'Fire',
  FireWalk: 'FireWalk',
  Reload: 'Reload',
  ReloadWalk: 'ReloadWalk',
  ReloadRun: 'ReloadRun',
  WalkF: 'WalkF',
  WalkFR: 'WalkFR',
  WalkR: 'WalkR',
  WalkBR: 'WalkBR',
  WalkB: 'WalkB',
  WalkBL: 'WalkBL',
  WalkL: 'WalkL',
  WalkFL: 'WalkFL',
  RunF: 'RunF',
  RunFR: 'RunFR',
  RunR: 'RunR',
  RunBR: 'RunBR',
  RunB: 'RunB',
  RunBL: 'RunBL',
  RunL: 'RunL',
  RunFL: 'RunFL',
};

// Override Vault: the Mixamo clip is 4.2s including a long approach-run
// before the actual leap. Skip the run-up by starting the action at this
// offset (in seconds of clip time), and play the rest at VAULT_TIMESCALE so
// the visible leap+landing fits VAULT.durationMs in real time.
//   real_duration = (4.2 - VAULT_START_TIME) / VAULT_TIMESCALE
const VAULT_START_TIME = 1.0;
const VAULT_TIMESCALE = 2.1;

// Per-clip playback speed multiplier. Mixamo's stock locomotion clips animate
// at their own pace, slower than our walkSpeed/sprintSpeed in world space, so
// doubling the playback rate roughly matches the cycle to actual ground speed.
const CLIP_TIMESCALE: Record<ClipKey, number> = {
  Idle: 1,
  Jump: 0, // unused (Jump path freezes the action)
  Vault: VAULT_TIMESCALE,
  Death: 1,
  Fire: 1,
  FireWalk: 1,
  Reload: 1,
  ReloadWalk: 1,
  ReloadRun: 1,
  WalkF: 2, WalkFR: 2, WalkR: 2, WalkBR: 2, WalkB: 2, WalkBL: 2, WalkL: 2, WalkFL: 2,
  RunF: 1, RunFR: 1, RunR: 1, RunBR: 1, RunB: 1, RunBL: 1, RunL: 1, RunFL: 1,
};

// Snap (localForward, localRight) to one of 8 cardinal/diagonal directions.
// theta is measured from the forward axis, positive toward the right.
const DIRS_BY_OCTANT: readonly Dir[] = ['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL'];
const directionFromVelocity = (lf: number, lr: number): Dir => {
  const theta = Math.atan2(lr, lf);
  const idx = ((Math.round(theta / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRS_BY_OCTANT[idx]!;
};

export const Character = ({ velocity, yaw, reloading, vaulting, alive, playerId, characterId = 'soldier' }: Props) => {
  const gltf = useGLTF(MODEL_URLS[characterId] ?? MODEL_URLS.soldier);
  const cloned = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  // Mixamo animations carry root motion in the Hips bone's position track —
  // the character translates forward during Walk/Run, jumps in Y during a
  // Jump clip, etc. Our server controls position authoritatively, so leaving
  // these in causes the model to drift forward and snap back on every
  // snapshot. Strip them here, keeping all rotation tracks intact.
  const animations = useMemo(() => stripRootMotion(gltf.animations), [gltf.animations]);
  const { actions } = useAnimations(animations, cloned);
  const currentAnim = useRef<ClipKey>('Idle');

  // Fire state: true while we want to be playing the Fire clip. Cleared by
  // a timer FIRE_HOLD_MS after the most recent shot event for this player.
  const [firing, setFiring] = useState(false);
  const fireTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp-based detection. Length-based comparison silently breaks once
  // the store's 200-event cap fills: array length stays pinned and the
  // subscriber stops firing, killing muzzle flash + Fire animation triggers
  // after a couple dozen seconds of play. Server-assigned `at` is monotonic.
  const lastAtRef = useRef<number>(-1);
  const muzzleFlashUntilRef = useRef(0);

  useEffect(() => {
    if (!playerId) return;
    const initial = useGame.getState().events;
    lastAtRef.current = initial.length ? Math.max(...initial.map((e) => e.at)) : -1;
    return useGame.subscribe((state) => {
      let firedThisBatch = false;
      let maxAt = lastAtRef.current;
      for (const ev of state.events) {
        if (ev.at <= lastAtRef.current) continue;
        if (ev.at > maxAt) maxAt = ev.at;
        if (ev.type === 'shot' && ev.shooterId === playerId) firedThisBatch = true;
      }
      lastAtRef.current = maxAt;
      if (!firedThisBatch) return;
      setFiring(true);
      muzzleFlashUntilRef.current = performance.now() + MUZZLE_FLASH_MS;
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
  // Mixamo skeletons exported from Blender end up with a ~0.001 cumulative
  // world scale on every bone — bone-as-parent makes any child invisible
  // unless you compensate. Workaround: parent the gun to the wrapper group
  // (NOT the bone) and copy the bone's world transform onto the gun each
  // frame. This way the gun follows the hand without inheriting the
  // skeleton's scale weirdness.
  const gunMeshRef = useRef<Group | null>(null);
  const wrapperRef = useRef<Group | null>(null);
  const handBoneRef = useRef<Object3D | null>(null);
  const gunLocalMatrix = useMemo(() => {
    const m = new Matrix4();
    m.compose(
      new Vector3(GUN_POS_X, GUN_POS_Y, GUN_POS_Z),
      new Quaternion().setFromEuler(new Euler(GUN_ROT_X, GUN_ROT_Y, GUN_ROT_Z, 'XYZ')),
      new Vector3(GUN_SCALE, GUN_SCALE, GUN_SCALE),
    );
    return m;
  }, []);
  const tmpMat = useMemo(() => new Matrix4(), []);
  const tmpInv = useMemo(() => new Matrix4(), []);

  useEffect(() => {
    handBoneRef.current = findRightHandBone(cloned);
    if (!handBoneRef.current) {
      console.warn('Character: no right-hand bone found, gun not attached');
    }
    return () => {
      handBoneRef.current = null;
    };
  }, [cloned]);

  useFrame(() => {
    const wrapper = wrapperRef.current;
    const gun = gunMeshRef.current;
    const bone = handBoneRef.current;
    if (!wrapper || !gun || !bone) return;
    // Get the bone's world position, convert to wrapper-local. We skip
    // rotation tracking on purpose — Mixamo's bone world matrix bakes a
    // ~0.001 cumulative scale that contaminates rotation extraction.
    // Using a fixed orientation works because the wrapper already faces
    // the player's forward direction; rotation.y = π flips the gun's
    // local -Z (barrel) to point forward.
    bone.getWorldPosition(gun.position);
    wrapper.worldToLocal(gun.position);
    gun.rotation.set(0, Math.PI, 0);
    gun.scale.setScalar(GUN_SCALE);

    const flash = gun.getObjectByName('muzzleFlash');
    if (flash) flash.visible = performance.now() < muzzleFlashUntilRef.current;
  });

  // State machine. Acts only on actual transitions.
  useEffect(() => {
    // Decompose world velocity into facing-relative components. Server
    // convention (sim.ts): vx = -sin(yaw)*fwd + cos(yaw)*right, vz =
    // -cos(yaw)*fwd - sin(yaw)*right. Inverting gives the formulas below.
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const localForward = -velocity[0] * sy - velocity[2] * cy;
    const localRight = velocity[0] * cy - velocity[2] * sy;
    const speed = Math.hypot(localForward, localRight);
    const airborne = Math.abs(velocity[1]) > AIRBORNE_VY;
    const fireClip = CLIP_NAMES.Fire ? actions[CLIP_NAMES.Fire] : undefined;
    const fireWalkClip = CLIP_NAMES.FireWalk ? actions[CLIP_NAMES.FireWalk] : undefined;
    const reloadClip = CLIP_NAMES.Reload ? actions[CLIP_NAMES.Reload] : undefined;
    const reloadWalkClip = CLIP_NAMES.ReloadWalk ? actions[CLIP_NAMES.ReloadWalk] : undefined;
    const reloadRunClip = CLIP_NAMES.ReloadRun ? actions[CLIP_NAMES.ReloadRun] : undefined;
    const vaultClip = CLIP_NAMES.Vault ? actions[CLIP_NAMES.Vault] : undefined;
    const deathClip = CLIP_NAMES.Death ? actions[CLIP_NAMES.Death] : undefined;

    // Priority: Death > Vault > Reload > Fire > Jump (airborne) > locomotion.
    // Death wins over everything — once the player is killed, every other
    // animation is overridden until they respawn.
    let desired: ClipKey;
    if (!alive && deathClip) {
      desired = 'Death';
    } else if (!alive) {
      // No Death clip in the GLB — fade everything out (legacy behavior).
      for (const a of Object.values(actions)) a?.fadeOut(0.2);
      return;
    } else if (vaulting && vaultClip) {
      desired = 'Vault';
    } else if (reloading && !airborne && speed >= WALK_RUN_THRESHOLD && reloadRunClip) {
      desired = 'ReloadRun';
    } else if (reloading && !airborne && speed >= IDLE_SPEED && reloadWalkClip) {
      desired = 'ReloadWalk';
    } else if (reloading && reloadClip && !airborne) {
      desired = 'Reload';
    } else if (firing && !airborne && speed >= IDLE_SPEED && fireWalkClip) {
      desired = 'FireWalk';
    } else if (firing && fireClip && !airborne) {
      desired = 'Fire';
    } else if (airborne) {
      desired = 'Jump';
    } else if (speed < IDLE_SPEED) {
      desired = 'Idle';
    } else {
      const dir = directionFromVelocity(localForward, localRight);
      desired = (speed < WALK_RUN_THRESHOLD ? `Walk${dir}` : `Run${dir}`) as ClipKey;
    }

    // Fall back gracefully if a clip isn't bound (e.g. loading order, or a
    // diagonal clip missing from a future trimmed GLB).
    const wanted: ClipKey =
      pickAction(actions, desired)
        ? desired
        : speed < WALK_RUN_THRESHOLD
          ? pickAction(actions, 'WalkF') ? 'WalkF' : 'Idle'
          : pickAction(actions, 'RunF') ? 'RunF' : 'Idle';

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
  }, [velocity, yaw, reloading, vaulting, alive, firing, actions]);

  // Note: deliberately NOT returning null when !alive — we want the corpse
  // to remain visible playing the Death clip until the server respawns the
  // player (PLAYER.respawnMs).

  // Mixamo character: origin at feet, native forward is +z. Our world has
  // forward = -z at yaw=0, so we apply a 180° y rotation to align them.
  // The position offset pushes feet to ground (player position is capsule center).
  // Gun is rendered as a sibling of the cloned model inside the same wrapper
  // group; useFrame updates its matrix to follow the right-hand bone in
  // wrapper-local space, sidestepping the bone's small world-scale that
  // makes bone-attached children invisible.
  return (
    <group ref={wrapperRef} position={[0, -PLAYER.height / 2, 0]} rotation={[0, Math.PI, 0]}>
      <primitive object={cloned} />
      <CharacterGun gunMeshRef={gunMeshRef} />
    </group>
  );
};

const CharacterGun = ({ gunMeshRef }: { gunMeshRef: React.MutableRefObject<Group | null> }) => {
  const gun = useMemo(() => createRifleMesh(), []);
  useEffect(() => {
    gunMeshRef.current = gun;
    return () => {
      if (gunMeshRef.current === gun) gunMeshRef.current = null;
      gun.traverse((obj) => {
        if (obj instanceof Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof MeshStandardMaterial) obj.material.dispose();
        }
      });
    };
  }, [gun, gunMeshRef]);
  return <primitive object={gun} />;
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
  action.timeScale = CLIP_TIMESCALE[mode] ?? 1;
  if (freshClip && (mode === 'Fire' || mode === 'Reload' || mode === 'ReloadWalk' || mode === 'ReloadRun' || mode === 'Death')) {
    // Restart these clips from the beginning so each shot/reload/death replays cleanly.
    action.time = 0;
  }
  if (freshClip && mode === 'Vault') {
    // Skip the approach-run portion at the start of the Mixamo clip.
    action.time = VAULT_START_TIME;
  }
  // Vault and Death are one-shot — looping would restart the leap mid-air or
  // the death mid-fall. Hold the final pose at the end (clampWhenFinished)
  // until the server clears the state (vault completes / player respawns).
  if (mode === 'Vault' || mode === 'Death') {
    action.loop = LoopOnce;
    action.clampWhenFinished = true;
  } else {
    action.loop = LoopRepeat;
    action.clampWhenFinished = false;
  }
};

// =============================================================================
// Rifle attached to the right-hand bone.
// Mixamo bone convention: hand bone's local +Y points along the fingers.
// Gun mesh convention: barrel along local -Z, top of receiver along +Y.
// To get barrel-along-finger-direction we rotate the gun -90° around X
// (so gun's local -Z aligns with bone's local +Y, and gun's +Y rolls to +Z).
// Position offset is small — the gun's origin is at the pistol grip, so
// putting it slightly "forward" along the bone (+Y in bone-local) places
// the grip in the palm.
// =============================================================================
const GUN_POS_X = 0;
const GUN_POS_Y = 0.04;
const GUN_POS_Z = 0;
const GUN_ROT_X = -Math.PI / 2;
const GUN_ROT_Y = 0;
const GUN_ROT_Z = 0;
const GUN_SCALE = 1;

// Drop position tracks on the Hips (root) bone from every clip, replacing
// each clip with a copy whose tracks are filtered. Keeps rotation tracks so
// limbs still animate; removes only the translation that competes with the
// server's authoritative position.
//
// Exception: clips whose visual REQUIRES the Hips Y descent — Death drops the
// body to the floor via Hips.y. Stripping it leaves the corpse hovering at
// standing height. We keep all Hips translation for these (X/Z drift is
// negligible for a death-in-place clip).
const KEEP_ROOT_MOTION = new Set(['Death']);
const stripRootMotion = (clips: readonly AnimationClip[]): AnimationClip[] =>
  clips.map((clip) => {
    if (KEEP_ROOT_MOTION.has(clip.name)) return clip;
    const tracks = clip.tracks.filter(
      (t) => !/Hips\.position$/i.test(t.name) && !/Hips\.scale$/i.test(t.name),
    );
    return new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
  });

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

  // Muzzle flash — at the barrel tip, hidden by default. Toggled visible for
  // ~one frame on shot events. Unlit material + fog disabled so it pops.
  const muzzleFlash = new Mesh(
    new SphereGeometry(0.06, 10, 10),
    new MeshBasicMaterial({ color: '#fff5a0', transparent: true, opacity: 0.95, fog: false }),
  );
  muzzleFlash.position.set(0, 0.09, -0.62);
  muzzleFlash.name = 'muzzleFlash';
  muzzleFlash.visible = false;
  gun.add(muzzleFlash);

  return gun;
};
