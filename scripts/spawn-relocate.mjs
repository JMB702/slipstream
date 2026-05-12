import { FPS_SHOOTER_OBSTACLES } from '../packages/shared/src/maps/fps_shooter.collision.ts';

const PLAYER_R = 0.4;
const PLAYER_HALF_H = 1.0;
const SPAWN_Y = 4;
const BOUND = 11.5;

// Points to consider for re-relocation (anything outside ±11.5 or that we want re-checked).
const candidates = [
  ['Spawn_05', 15.432, 11.098],
  ['Spawn_06', -12.146, -8.085],
];

const insideAt = (x, y, z) => {
  for (const o of FPS_SHOOTER_OBSTACLES) {
    if (
      x > o.pos[0] - o.halfSize[0] - PLAYER_R &&
      x < o.pos[0] + o.halfSize[0] + PLAYER_R &&
      y > o.pos[1] - o.halfSize[1] - PLAYER_HALF_H &&
      y < o.pos[1] + o.halfSize[1] + PLAYER_HALF_H &&
      z > o.pos[2] - o.halfSize[2] - PLAYER_R &&
      z < o.pos[2] + o.halfSize[2] + PLAYER_R
    )
      return true;
  }
  return false;
};

const topUnder = (x, z, ceilingY) => {
  let top = -Infinity;
  for (const o of FPS_SHOOTER_OBSTACLES) {
    if (
      x > o.pos[0] - o.halfSize[0] - PLAYER_R &&
      x < o.pos[0] + o.halfSize[0] + PLAYER_R &&
      z > o.pos[2] - o.halfSize[2] - PLAYER_R &&
      z < o.pos[2] + o.halfSize[2] + PLAYER_R
    ) {
      const t = o.pos[1] + o.halfSize[1];
      if (t <= ceilingY && t > top) top = t;
    }
  }
  return top === -Infinity ? null : top;
};

const findClear = (x0, z0) => {
  const dirToOrigin = Math.atan2(-z0, -x0);
  for (let r = 0.5; r <= 8.0; r += 0.25) {
    for (let dTheta = 0; dTheta <= Math.PI; dTheta += Math.PI / 16) {
      for (const sign of dTheta === 0 ? [0] : [-1, 1]) {
        const theta = dirToOrigin + sign * dTheta;
        const x = x0 + r * Math.cos(theta);
        const z = z0 + r * Math.sin(theta);
        if (x < -BOUND || x > BOUND || z < -BOUND || z > BOUND) continue;
        if (insideAt(x, SPAWN_Y, z)) continue;
        const t = topUnder(x, z, SPAWN_Y - PLAYER_HALF_H);
        if (t === null) continue;
        if (t > 2.5) continue;
        return { x, z, r, surface: t };
      }
    }
  }
  return null;
};

const moves = [];
for (const [name, x, z] of candidates) {
  const t = findClear(x, z);
  if (!t) {
    console.log(name, 'no clear spot');
    continue;
  }
  moves.push([name, t.x, t.z]);
  console.log(
    name,
    `old=(${x.toFixed(2)},${z.toFixed(2)}) -> new=(${t.x.toFixed(2)},${t.z.toFixed(2)}) dist=${t.r.toFixed(2)} surface_y=${t.surface.toFixed(2)}`,
  );
}
console.log('\nMOVES_JSON', JSON.stringify(moves));
