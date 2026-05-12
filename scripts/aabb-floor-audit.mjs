import { FPS_SHOOTER_OBSTACLES } from '../packages/shared/src/maps/fps_shooter.collision.ts';

const bins = { 'top<=1.0': 0, 'top<=1.5': 0, 'top<=2.0': 0, 'top<=3.0': 0, 'top>3.0': 0 };
const bottomBuckets = new Map();
for (const o of FPS_SHOOTER_OBSTACLES) {
  const top = o.pos[1] + o.halfSize[1];
  const bot = o.pos[1] - o.halfSize[1];
  if (top <= 1.0) bins['top<=1.0']++;
  else if (top <= 1.5) bins['top<=1.5']++;
  else if (top <= 2.0) bins['top<=2.0']++;
  else if (top <= 3.0) bins['top<=3.0']++;
  else bins['top>3.0']++;
  const key = bot.toFixed(2);
  bottomBuckets.set(key, (bottomBuckets.get(key) ?? 0) + 1);
}
console.log('Top distribution:', bins);
console.log('\nTop-N bottom values:');
[...bottomBuckets.entries()].sort((a,b) => b[1]-a[1]).slice(0,10).forEach(([bot, n]) => console.log(`  bottom=${bot}: ${n} AABBs`));
