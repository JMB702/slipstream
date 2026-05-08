import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Group } from 'three';
import {
  PLAYER,
  TICK_MS,
  applyMovement,
  type ClientMessage,
  type InputFrame,
  type MovableState,
} from '@slipstream/shared';
import { useGame } from '../store.js';
import { createInput } from './input.js';
import { setActiveInput, setPredictedState, consumeFire } from './local-state.js';
import { PlayerModel } from './PlayerModel.js';

interface Props {
  send(msg: ClientMessage): void;
  myName: string;
}

export const LocalPlayer = ({ send, myName }: Props) => {
  const ref = useRef<Group>(null);
  const { gl } = useThree();
  const seqRef = useRef(1);
  const accumulator = useRef(0);
  const lastSent = useRef(performance.now());
  const inputBuffer = useRef<InputFrame[]>([]);
  const liveInputRef = useRef<ReturnType<typeof createInput> | null>(null);

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
      });
    }

    setPredictedState(state);

    ref.current.position.set(state.position[0], state.position[1], state.position[2]);
    ref.current.rotation.y = state.yaw;
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
        playerId={myId ?? null}
      />
    </group>
  );
};
