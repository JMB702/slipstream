import { FPS_SHOOTER_OBSTACLES } from '../packages/shared/src/maps/fps_shooter.collision.ts';

const PLAYER_R = 0.4;
const PLAYER_HALF_H = 1.0;
const SPAWN_Y = 4;

const stuck = [
  ['Spawn_00', 3.346, -11.4],
  ['Spawn_01', 8.862, -8.762],
  ['Spawn_04', -1.419, -11.492],
  ['Spawn_05', 15.432, 11.098],
  ['Spawn_06', -12.146, -8.085],
  ['Spawn_07', 5.063, -4.031],
  ['Spawn_09', 7.06, -11.504],
  ['Spawn_11', -3.834, -8.268],
  ['Spawn_12', 10.973, -3.922],
  ['Spawn_14', 8.494, 8.748],
  ['Spawn_16', 0.397, 11.521],
  ['Spawn_17', -4.967, 4.097],
  ['Spawn_18', -8.931, 8.792],
  ['Spawn_19', 8.681, 1.856],
  ['Spawn_20', 4.472, -11.509],
  ['Spawn_22', -9.247, -8.884],
  ['Spawn_23', -9.576, -5.329],
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

console.log('name      gxz                 verdict');
console.log('--------- ------------------- -------------------------------------');
for (const [name, x, z] of stuck) {
  const obs = (() => {
    for (const o of FPS_SHOOTER_OBSTACLES) {
      if (
        x > o.pos[0] - o.halfSize[0] - PLAYER_R &&
        x < o.pos[0] + o.halfSize[0] + PLAYER_R &&
        SPAWN_Y > o.pos[1] - o.halfSize[1] - PLAYER_HALF_H &&
        SPAWN_Y < o.pos[1] + o.halfSize[1] + PLAYER_HALF_H &&
        z > o.pos[2] - o.halfSize[2] - PLAYER_R &&
        z < o.pos[2] + o.halfSize[2] + PLAYER_R
      )
        return o;
    }
    return null;
  })();
  if (obs) {
    console.log(name.padEnd(9), `(${x.toFixed(2).padStart(6)}, ${z.toFixed(2).padStart(7)})`, 'STUCK');
    continue;
  }
  const t = topUnder(x, z, SPAWN_Y - PLAYER_HALF_H);
  if (t === null) {
    console.log(name.padEnd(9), `(${x.toFixed(2).padStart(6)}, ${z.toFixed(2).padStart(7)})`, 'NO FLOOR');
    continue;
  }
  console.log(
    name.padEnd(9),
    `(${x.toFixed(2).padStart(6)}, ${z.toFixed(2).padStart(7)})`,
    `lands surface_y=${t.toFixed(2)} (drop=${(SPAWN_Y - (t + PLAYER_HALF_H)).toFixed(2)}m)`,
  );
}
