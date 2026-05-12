import { FPS_SHOOTER_OBSTACLES } from '../packages/shared/src/maps/fps_shooter.collision.ts';

const PLAYER_R = 0.4;
const PLAYER_HALF_H = 1.0;
const SPAWN_Y = 4;
const PLAY_HALF = 9.5;

const candidates = [
  ['Spawn_00', 3.346, -11.4],
  ['Spawn_04', -1.419, -11.492],
  ['Spawn_05', 10.561, 7.595],
  ['Spawn_06', -11.45, -7.047],
  ['Spawn_09', 7.06, -11.504],
  ['Spawn_12', 10.973, -3.922],
  ['Spawn_16', 0.397, 11.521],
  ['Spawn_20', 4.472, -11.509],
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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Pull (x,z) into the play box. If the clamped point is stuck on an interior
// obstacle, spiral outward (but staying inside the play box) until clear.
const relocate = (x0, z0) => {
  const tx = clamp(x0, -PLAY_HALF, PLAY_HALF);
  const tz = clamp(z0, -PLAY_HALF, PLAY_HALF);
  if (!insideAt(tx, SPAWN_Y, tz)) return { x: tx, z: tz, r: 0 };
  for (let r = 0.5; r <= 6.0; r += 0.5) {
    for (let dTheta = 0; dTheta < Math.PI * 2; dTheta += Math.PI / 12) {
      const x = tx + r * Math.cos(dTheta);
      const z = tz + r * Math.sin(dTheta);
      if (x < -PLAY_HALF || x > PLAY_HALF || z < -PLAY_HALF || z > PLAY_HALF) continue;
      if (!insideAt(x, SPAWN_Y, z)) return { x, z, r };
    }
  }
  return null;
};

const moves = [];
console.log('name      old_xz                  new_xz                  r');
console.log('--------- ----------------------- ----------------------- -----');
for (const [name, x, z] of candidates) {
  const t = relocate(x, z);
  if (!t) {
    console.log(name.padEnd(9), 'NO CLEAR SPOT');
    continue;
  }
  moves.push([name, t.x, t.z]);
  console.log(
    name.padEnd(9),
    `(${x.toFixed(2).padStart(7)}, ${z.toFixed(2).padStart(7)})`,
    `(${t.x.toFixed(2).padStart(7)}, ${t.z.toFixed(2).padStart(7)})`,
    t.r.toFixed(2).padStart(4),
  );
}
console.log('\nMOVES_JSON', JSON.stringify(moves));
