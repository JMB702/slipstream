import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Group, Vector3 } from 'three';
import {
  PLAYER,
  TICK_MS,
  applyMovement,
  type ClientMessage,
  type InputFrame,
  type MovableState,
  type Vec3,
} from '@slipstream/shared';
import { useGame } from '../store.js';
import { createInput } from './input.js';
import { setActiveInput, setPredictedState, consumeFire } from './local-state.js';
import { castCameraRay, findAimTarget, stampAimedAt } from './aim-state.js';
import { hapticFire } from './haptics.js';
import { playDryFire } from './sfx.js';
import { PlayerModel } from './PlayerModel.js';

interface Props {
  send(msg: ClientMessage): void;
  myName: string;
}

export const LocalPlayer = ({ send, myName }: Props) => {
  const ref = useRef<Group>(null);
  const { gl, camera } = useThree();
  const seqRef = useRef(1);
  const accumulator = useRef(0);
  const lastSent = useRef(performance.now());
  const inputBuffer = useRef<InputFrame[]>([]);
  const liveInputRef = useRef<ReturnType<typeof createInput> | null>(null);
  // Reused scratch vector for camera.getWorldDirection() — avoids per-frame
  // allocation in the input-frame builder.
  const camFwdScratch = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const input = createInput(gl.domElement);
    liveInputRef.current = input;
    setActiveInput(input);
    return () => {
      input.destroy();
      if (liveInputRef.current === input) liveInputRef.current = null;
      setActiveInput(null);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const dtMs = delta * 1000;
    accumulator.current += dtMs;

    const live = liveInputRef.current?.state;

    if (accumulator.current >= TICK_MS && live) {
      const sendDt = performance.now() - lastSent.current;
      lastSent.current = performance.now();
      accumulator.current = 0;

      const fired = consumeFire();
      if (fired) {
        // Server is authoritative on ammo and life; don't buzz on dry-fire
        // pulls or trigger-mashing while dead.
        const myId = useGame.getState().myId;
        const snap = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
        const meNow = myId ? snap?.players.get(myId) : undefined;
        if (meNow && meNow.alive && meNow.ammo > 0) {
          hapticFire();
        } else if (meNow && meNow.alive && meNow.ammo <= 0) {
          playDryFire();
        }
      }
      // Camera-resolved aim. Cast from the camera (which sees over ledges,
      // around shoulders, etc.) and find the first wall or player capsule.
      // Server uses this as authoritative origin/direction so third-person
      // parallax doesn't make eye-blocked shots fail when the reticle clearly
      // shows a hit. Live snapshot positions for visual matching; server does
      // its own lag-comp test from the same origin/direction.
      let aimOrigin: Vec3 | null = null;
      let aim: Vec3 | null = null;
      const myIdNow = useGame.getState().myId;
      const lastSnapNow =
        useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
      if (myIdNow && lastSnapNow) {
        camera.getWorldDirection(camFwdScratch);
        aimOrigin = [camera.position.x, camera.position.y, camera.position.z];
        const hit = castCameraRay(
          aimOrigin,
          [camFwdScratch.x, camFwdScratch.y, camFwdScratch.z],
          myIdNow,
          lastSnapNow.players.values(),
        );
        aim = hit.point;
      }
      const frame: InputFrame = {
        seq: seqRef.current++,
        dtMs: sendDt,
        forward: live.forward,
        right: live.right,
        jump: live.jump,
        // Can't sprint while firing. Server enforces this too; doing it here
        // keeps client prediction matching the server's authoritative state.
        sprint: live.sprint && !fired,
        fire: fired,
        reload: live.reload,
        yaw: live.yaw,
        pitch: live.pitch,
        aimOrigin,
        aim,
      };
      inputBuffer.current.push(frame);
      if (inputBuffer.current.length > 120) inputBuffer.current.shift();
      send({ type: 'input', frames: [frame] });
    }

    const myId = useGame.getState().myId;
    const lastSnap = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
    if (!ref.current || !myId || !lastSnap) return;
    const me = lastSnap.players.get(myId);
    if (!me) return;

    if (!me.alive) {
      setPredictedState({
        position: me.position,
        velocity: [0, 0, 0],
        yaw: me.yaw,
        pitch: me.pitch,
        grounded: true,
      });
      ref.current.position.set(me.position[0], me.position[1], me.position[2]);
      ref.current.rotation.y = me.yaw;
      return;
    }

    // While vaulting, the server tweens position; client prediction would
    // fight the tween (movement input is ignored server-side anyway). Lerp
    // the wrapper toward the latest snapshot position rather than snapping —
    // snapshots arrive at 20 Hz so a hard set produces visible step jitter
    // at the 60 Hz render rate.
    if (me.vaulting) {
      const cx = ref.current.position.x;
      const cy = ref.current.position.y;
      const cz = ref.current.position.z;
      const lerpAmt = 0.35;
      const nx = cx + (me.position[0] - cx) * lerpAmt;
      const ny = cy + (me.position[1] - cy) * lerpAmt;
      const nz = cz + (me.position[2] - cz) * lerpAmt;
      ref.current.position.set(nx, ny, nz);
      ref.current.rotation.y = me.yaw;
      setPredictedState({
        position: [nx, ny, nz],
        velocity: [0, 0, 0],
        yaw: me.yaw,
        pitch: me.pitch,
        grounded: false,
      });
      // Keep the buffer drained so when the vault ends we don't replay stale jumps.
      const ackedSeq = me.lastSeenSeq;
      while (inputBuffer.current.length > 0 && inputBuffer.current[0]!.seq <= ackedSeq) {
        inputBuffer.current.shift();
      }
      return;
    }

    const ackedSeq = me.lastSeenSeq;
    while (inputBuffer.current.length > 0 && inputBuffer.current[0]!.seq <= ackedSeq) {
      inputBuffer.current.shift();
    }

    let state: MovableState = {
      position: me.position,
      velocity: me.velocity,
      yaw: me.yaw,
      pitch: me.pitch,
      grounded: me.position[1] <= PLAYER.height / 2 + 0.001,
    };
    for (const frame of inputBuffer.current) {
      state = applyMovement(state, frame);
    }

    // Extrapolate the partial frame between the last sent input and now
    // so motion is continuous between 30Hz input ticks.
    const partialDtMs = performance.now() - lastSent.current;
    if (partialDtMs > 0 && live) {
      state = applyMovement(state, {
        seq: 0,
        dtMs: partialDtMs,
        forward: live.forward,
        right: live.right,
        jump: false,
        sprint: live.sprint,
        fire: false,
        reload: false,
        yaw: live.yaw,
        pitch: live.pitch,
        // Local-only prediction frame; never serialized over the wire.
        aimOrigin: null,
        aim: null,
      });
    }

    setPredictedState(state);

    ref.current.position.set(state.position[0], state.position[1], state.position[2]);
    ref.current.rotation.y = state.yaw;

    // Aim-target detection for enemy nameplate reveal. Mirrors server fire
    // raycast — same eye height, same hit radius, same wall occlusion. Stamps
    // the aim-state module so every PlayerModel can read its own last-aimed-at
    // time without a global re-render.
    const aimedId = findAimTarget(state.position, state.yaw, state.pitch, myId, lastSnap.players.values());
    if (aimedId) stampAimedAt(aimedId, performance.now());
  });

  const myId = useGame((s) => s.myId);
  const lastSnap = useGame((s) => s.snapshots[s.snapshots.length - 1]);
  const me = myId ? lastSnap?.players.get(myId) : undefined;

  return (
    <group ref={ref}>
      <PlayerModel
        name={me?.name ?? myName}
        alive={me?.alive ?? true}
        health={me?.health ?? 100}
        velocity={me?.velocity ?? [0, 0, 0]}
        yaw={me?.yaw ?? 0}
        reloading={me?.reloading ?? false}
        vaulting={me?.vaulting ?? false}
        playerId={myId ?? null}
      />
    </group>
  );
};
