// Gamepad rumble. Uses the standard `vibrationActuator.playEffect('dual-rumble',
// ...)` path. No-op if no controller is connected or the browser doesn't expose
// the actuator — we never want haptics-not-supported to surface as a runtime
// error to the user.

interface DualRumbleEffect {
  duration: number;
  startDelay?: number;
  strongMagnitude: number;
  weakMagnitude: number;
}

interface VibrationActuator {
  playEffect(type: 'dual-rumble', params: DualRumbleEffect): Promise<unknown>;
}

const getActuator = (): VibrationActuator | null => {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p || !p.connected) continue;
    const act = (p as Gamepad & { vibrationActuator?: VibrationActuator }).vibrationActuator;
    if (act && typeof act.playEffect === 'function') return act;
  }
  return null;
};

const play = (effect: DualRumbleEffect): void => {
  const act = getActuator();
  if (!act) return;
  // playEffect returns a promise that rejects if the browser interrupts it
  // (e.g., another effect started). We don't care — swallow.
  act.playEffect('dual-rumble', effect).catch(() => {});
};

// Short, sharp tick on the trigger side. Tuned to feel like a light recoil
// pulse, not a sustained buzz — consistent with semi-auto fire cadence.
export const hapticFire = (): void => {
  play({ duration: 60, strongMagnitude: 0.45, weakMagnitude: 0.65 });
};

// Heavier hit — longer duration, both motors at higher magnitude. Distinct
// from hapticFire so the player can tell incoming damage apart from their
// own shots without looking.
export const hapticDamage = (): void => {
  play({ duration: 200, strongMagnitude: 0.85, weakMagnitude: 0.4 });
};
