import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type AnimationAction,
} from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLAYER, type PlayerId, type Vec3 } from '@slipstream/shared';
import { useGame } from '../store.js';

const MODEL_URL = '/models/Soldier.glb';

// Trigger the fetch as soon as the bundle loads so the first character mount
// doesn't have to wait on the network.
useGLTF.preload(MODEL_URL);

interface Props {
  velocity: Vec3;
  alive: boolean;
  playerId: PlayerId | null;
}

const WALK_RUN_THRESHOLD = (PLAYER.walkSpeed + PLAYER.sprintSpeed) / 2;
const IDLE_SPEED = 0.15;
const AIRBORNE_VY = 0.5; // |velocity.y| above this counts as airborne

type ClipKey = 'Idle' | 'Walk' | 'Run' | 'Jump';

export const Character = ({ velocity, alive, playerId }: Props) => {
  const gltf = useGLTF(MODEL_URL);
  // Drei's useGLTF returns a shared scene; clone for multi-instance use so
  // each character animates its own skeleton. Pass the cloned scene directly
  // to useAnimations so the mixer attaches to the object that actually
  // contains the bones (passing an outer wrapper ref relies on tree traversal
  // and has been a source of intermittent bind issues).
  const cloned = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const { actions } = useAnimations(gltf.animations, cloned);
  const currentAnim = useRef<ClipKey>('Idle');

  // Two-handed rifle, rendered as a fixed-offset child of the wrapper group
  // (NOT bone-parented). The character's hand bones swing during walk/run,
  // which would yank a hand-attached gun all over the place — and we don't
  // have aim-pose animations from Soldier.glb to hold the gun steady.
  // Fixed-offset means the gun stays cleanly forward of the chest at all
  // times: visible, two-handed-shaped, pointing the right way.
  const gun = useMemo(() => createGunMesh(), []);
  const gunRef = useRef<Group | null>(gun);
  const muzzleFlashRef = useRef<Mesh | null>(null);
  const fireAnimRef = useRef(0); // 0..1 progress of recoil animation; 1 = at rest

  useEffect(() => {
    return () => {
      gun.traverse((obj) => {
        if (obj instanceof Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof MeshStandardMaterial) obj.material.dispose();
          if (obj.material instanceof MeshBasicMaterial) obj.material.dispose();
        }
      });
    };
  }, [gun]);

  // Listen for shot events from this player and trigger the recoil + flash.
  const seenEventsRef = useRef(0);
  useEffect(() => {
    return useGame.subscribe((state) => {
      if (!playerId) return;
      if (state.events.length === seenEventsRef.current) return;
      const fresh = state.events.slice(seenEventsRef.current);
      seenEventsRef.current = state.events.length;
      for (const ev of fresh) {
        if (ev.type === 'shot' && ev.shooterId === playerId) {
          fireAnimRef.current = 0; // restart recoil animation
        }
      }
    });
  }, [playerId]);

  // Per-frame: advance the recoil animation, drive gun position/rotation
  // and muzzle-flash visibility from it.
  useFrame((_, delta) => {
    const g = gunRef.current;
    if (!g) return;
    if (fireAnimRef.current < 1) {
      fireAnimRef.current = Math.min(1, fireAnimRef.current + delta / RECOIL_DURATION_S);
    }
    const t = fireAnimRef.current;
    // Recoil curve: kick back fast (0..0.25), settle slow (0.25..1).
    const kick = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75;
    g.position.set(GUN_POS_X, GUN_POS_Y, GUN_POS_Z + kick * RECOIL_KICK);
    g.rotation.set(-kick * RECOIL_PITCH, GUN_ROT_Y, GUN_ROT_Z);

    const mf = muzzleFlashRef.current;
    if (mf) {
      const flashAlpha = t < 0.08 ? 1 : 0;
      mf.visible = flashAlpha > 0;
      mf.scale.setScalar(0.04 + (1 - t / 0.08) * 0.04);
    }
  });

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
      <primitive object={gun} />
      {/* Muzzle flash sphere — tucked at the barrel tip, hidden until shot fires */}
      <mesh
        ref={muzzleFlashRef}
        position={[GUN_POS_X, GUN_POS_Y, GUN_POS_Z - GUN_BARREL_TIP_Z]}
        visible={false}
      >
        <sphereGeometry args={[0.05, 12, 12]} />
        <meshBasicMaterial color="#ffd060" transparent opacity={0.9} />
      </mesh>
    </group>
  );
};

// Run clip is ~0.7s; mid-stride lands around 0.35s with one leg planted —
// reads as a leap silhouette when frozen.
const JUMP_POSE_TIME = 0.35;

// ----- Gun -----
// Position/rotation in the wrapper group's local space (origin at the
// character's feet, +y up, -z = character's forward at yaw=0).
const GUN_POS_X = 0.18;            // slight right-hand bias
const GUN_POS_Y = 1.35;            // chest height (model is ~1.8m)
const GUN_POS_Z = -0.25;           // forward of the body
const GUN_ROT_Y = 0;               // gun's local -z is barrel direction; matches character forward
const GUN_ROT_Z = 0;
const GUN_BARREL_TIP_Z = 0.55;     // distance from gun origin to muzzle tip (used for flash placement)

const RECOIL_KICK = 0.06;          // meters the gun slides back per shot
const RECOIL_PITCH = 0.25;         // radians of muzzle rise per shot
const RECOIL_DURATION_S = 0.22;    // total recoil-and-settle time

// Two-handed rifle. Built so its local origin sits roughly between the
// shooter's hands (under the receiver), with the barrel extending in the
// -z direction and the stock extending in +z. Total length ~85cm.
const createGunMesh = (): Group => {
  const gun = new Group();

  const metal = new MeshStandardMaterial({ color: '#1a1a1a', metalness: 0.7, roughness: 0.35 });
  const wood = new MeshStandardMaterial({ color: '#3a2818', metalness: 0.05, roughness: 0.85 });

  // Receiver (main body) — sits at the gun origin
  const receiver = new Mesh(new BoxGeometry(0.06, 0.08, 0.3), metal);
  receiver.castShadow = true;
  gun.add(receiver);

  // Barrel — cylinder extending forward (-z)
  const barrel = new Mesh(new CylinderGeometry(0.015, 0.015, 0.4, 12), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.35);
  barrel.castShadow = true;
  gun.add(barrel);

  // Stock — extending backward (+z) from the receiver, where the shoulder rests
  const stock = new Mesh(new BoxGeometry(0.05, 0.08, 0.25), wood);
  stock.position.set(0, -0.01, 0.275);
  stock.castShadow = true;
  gun.add(stock);

  // Pistol grip — under the receiver, angled back. This is where the
  // dominant hand grips.
  const grip = new Mesh(new BoxGeometry(0.04, 0.11, 0.05), wood);
  grip.position.set(0, -0.085, 0.05);
  grip.rotation.x = -0.18;
  grip.castShadow = true;
  gun.add(grip);

  // Forend — under the barrel, where the support hand grips.
  const forend = new Mesh(new BoxGeometry(0.05, 0.04, 0.18), wood);
  forend.position.set(0, -0.04, -0.18);
  forend.castShadow = true;
  gun.add(forend);

  // Iron sight bump
  const sight = new Mesh(new BoxGeometry(0.012, 0.025, 0.02), metal);
  sight.position.set(0, 0.06, -0.05);
  gun.add(sight);

  return gun;
};

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
  // CRITICAL: three.js automatically sets enabled=false when a fadeOut
  // completes (interpolant value reaches 0). Subsequent fadeIn calls
  // schedule a weight interpolant but do NOT re-enable the action, so
  // its effective weight stays at 0 — and the model shows the bind pose
  // (T-pose). Force enabled=true on every transition.
  action.enabled = true;

  if (mode === 'Jump') {
    if (freshClip) action.time = JUMP_POSE_TIME;
    action.paused = true;
    action.timeScale = 0;
  } else {
    action.paused = false;
    action.timeScale = 1;
  }
};
