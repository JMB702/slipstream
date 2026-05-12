#!/usr/bin/env node
// Auto-extract AABB collision from a GLTF mesh map.
//
// Voxelizes every triangle in the scene at a fixed cell size, then greedy-
// merges contiguous solid voxels into maximal axis-aligned boxes. Output is
// a TypeScript file under packages/shared/src/maps/ that the runtime imports.
//
// Centers the result so the map's XZ bounding box sits on the origin and the
// floor sits at world y=0, matching the rest of Slipstream's coordinate
// conventions.
//
// Usage: node scripts/extract-map-collision.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const SOURCE_GLTF = join(REPO_ROOT, 'Maps/fps_shooter_game_arena_map_v3/scene.gltf');
const OUTPUT_TS = join(REPO_ROOT, 'packages/shared/src/maps/fps_shooter.collision.ts');

// Scale the source mesh. Applied to every vertex before voxelization; the
// GLTF is rendered at the same scale so collision and visuals line up.
const SCALE = 1;
// Voxel size — keep small enough for player radius (0.4 m) but coarse
// enough that the merged-AABB count stays manageable.
const CELL = 0.5;
// Negative cutoff = keep every voxel including the floor slab. The runtime
// resolves Y collisions against the floor obstacle the same way it does any
// other AABB, so as long as players spawn above the floor they land cleanly
// on top. The static `floor = halfH` clamp in sim.ts is just a safety net.
const FLOOR_CUTOFF_Y = -1;

const gltfDir = dirname(SOURCE_GLTF);
const gltf = JSON.parse(await readFile(SOURCE_GLTF, 'utf8'));
const buffers = await Promise.all(
  gltf.buffers.map((b) => readFile(join(gltfDir, b.uri))),
);

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_ELEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const accessorView = (idx) => {
  const acc = gltf.accessors[idx];
  const view = gltf.bufferViews[acc.bufferView];
  const buf = buffers[view.buffer];
  const elemSize = COMPONENT_SIZE[acc.componentType] * TYPE_ELEMS[acc.type];
  const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? elemSize;
  return { acc, buf, offset, stride };
};

const readVec3 = (idx) => {
  const { acc, buf, offset, stride } = accessorView(idx);
  const out = new Array(acc.count);
  for (let i = 0; i < acc.count; i++) {
    const o = offset + i * stride;
    out[i] = [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
  }
  return out;
};

const readIndices = (idx) => {
  const { acc, buf, offset } = accessorView(idx);
  const out = new Array(acc.count);
  if (acc.componentType === 5125) {
    for (let i = 0; i < acc.count; i++) out[i] = buf.readUInt32LE(offset + i * 4);
  } else if (acc.componentType === 5123) {
    for (let i = 0; i < acc.count; i++) out[i] = buf.readUInt16LE(offset + i * 2);
  } else if (acc.componentType === 5121) {
    for (let i = 0; i < acc.count; i++) out[i] = buf.readUInt8(offset + i);
  } else {
    throw new Error(`Unsupported index componentType ${acc.componentType}`);
  }
  return out;
};

const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const mulMat = (a, b) => {
  const out = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      out[i * 4 + j] = s;
    }
  }
  return out;
};

const transformPoint = (m, [x, y, z]) => {
  const w = m[12] * x + m[13] * y + m[14] * z + m[15];
  return [
    (m[0] * x + m[1] * y + m[2] * z + m[3]) / w,
    (m[4] * x + m[5] * y + m[6] * z + m[7]) / w,
    (m[8] * x + m[9] * y + m[10] * z + m[11]) / w,
  ];
};

// glTF stores matrices column-major; convert to row-major (m[row*4 + col]).
const nodeLocalMatrix = (node) => {
  if (node.matrix) {
    const c = node.matrix;
    return [
      c[0], c[4], c[8],  c[12],
      c[1], c[5], c[9],  c[13],
      c[2], c[6], c[10], c[14],
      c[3], c[7], c[11], c[15],
    ];
  }
  // TRS fallback (this map only uses matrices, but keep the path honest).
  let m = ident();
  if (node.translation) {
    const [tx, ty, tz] = node.translation;
    m = mulMat(m, [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]);
  }
  if (node.rotation) {
    const [x, y, z, w] = node.rotation;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    m = mulMat(m, [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 0,
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 0,
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), 0,
      0, 0, 0, 1,
    ]);
  }
  if (node.scale) {
    const [sx, sy, sz] = node.scale;
    m = mulMat(m, [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
  }
  return m;
};

// Walk every triangle in the scene, accumulating world-space vertices.
const triangles = [];
const scene = gltf.scenes[gltf.scene];
const visit = (nodeIdx, parentMat) => {
  const node = gltf.nodes[nodeIdx];
  const local = nodeLocalMatrix(node);
  const world = mulMat(parentMat, local);
  if (node.mesh != null) {
    const mesh = gltf.meshes[node.mesh];
    for (const prim of mesh.primitives) {
      if (prim.mode != null && prim.mode !== 4) continue; // only TRIANGLES
      const positions = readVec3(prim.attributes.POSITION);
      const indices = prim.indices != null ? readIndices(prim.indices) : null;
      const tri = (a, b, c) => {
        const va = transformPoint(world, positions[a]);
        const vb = transformPoint(world, positions[b]);
        const vc = transformPoint(world, positions[c]);
        for (const v of [va, vb, vc]) { v[0] *= SCALE; v[1] *= SCALE; v[2] *= SCALE; }
        triangles.push([va, vb, vc]);
      };
      if (indices) {
        for (let i = 0; i + 2 < indices.length; i += 3) tri(indices[i], indices[i + 1], indices[i + 2]);
      } else {
        for (let i = 0; i + 2 < positions.length; i += 3) tri(i, i + 1, i + 2);
      }
    }
  }
  for (const child of node.children ?? []) visit(child, world);
};
for (const root of scene.nodes) visit(root, ident());

console.log(`Loaded ${triangles.length} triangles`);

// World-space bounding box, then center on XZ, drop Y to floor=0.
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (const t of triangles) for (const v of t) {
  if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
  if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
  if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
}
console.log(`Raw bounds: x[${minX.toFixed(2)}..${maxX.toFixed(2)}] y[${minY.toFixed(2)}..${maxY.toFixed(2)}] z[${minZ.toFixed(2)}..${maxZ.toFixed(2)}]`);

const offsetX = -(minX + maxX) / 2;
const offsetY = -minY;
const offsetZ = -(minZ + maxZ) / 2;
for (const t of triangles) for (const v of t) {
  v[0] += offsetX;
  v[1] += offsetY;
  v[2] += offsetZ;
}

const sizeX = maxX - minX;
const sizeY = maxY - minY;
const sizeZ = maxZ - minZ;
const halfX = sizeX / 2;
const halfZ = sizeZ / 2;

console.log(`Centered bounds: x[±${halfX.toFixed(2)}] y[0..${sizeY.toFixed(2)}] z[±${halfZ.toFixed(2)}]`);

// Voxel grid spans the centered bounds, padded by a cell on each side.
const gx = Math.ceil(sizeX / CELL) + 2;
const gy = Math.ceil(sizeY / CELL) + 1;
const gz = Math.ceil(sizeZ / CELL) + 2;
const originX = -halfX - CELL;
const originY = 0;
const originZ = -halfZ - CELL;

const cellIdx = (ix, iy, iz) => (iy * gz + iz) * gx + ix;
const solid = new Uint8Array(gx * gy * gz);

// Sample each triangle barycentrically and mark every cell a sample lands
// in. This is more accurate than triangle-AABB voxelization, which
// over-marks: a long diagonal triangle's AABB can cover huge empty volumes.
// Sample density is tied to edge length so big triangles get more samples.
const SAMPLE_STEP = CELL * 0.4;
for (const [a, b, c] of triangles) {
  const eAB = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const eAC = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const n = Math.max(1, Math.ceil(Math.max(eAB, eAC) / SAMPLE_STEP));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n - i; j++) {
      const u = i / n;
      const v = j / n;
      const w = 1 - u - v;
      const x = a[0] * w + b[0] * u + c[0] * v;
      const y = a[1] * w + b[1] * u + c[1] * v;
      const z = a[2] * w + b[2] * u + c[2] * v;
      const ix = Math.floor((x - originX) / CELL);
      const iy = Math.floor((y - originY) / CELL);
      const iz = Math.floor((z - originZ) / CELL);
      if (ix >= 0 && ix < gx && iy >= 0 && iy < gy && iz >= 0 && iz < gz) {
        solid[cellIdx(ix, iy, iz)] = 1;
      }
    }
  }
}

// Drop the floor — runtime handles ground clamping. Anything whose center
// sits at or below FLOOR_CUTOFF_Y is "the floor" for our purposes.
for (let iy = 0; iy < gy; iy++) {
  const yCenter = originY + (iy + 0.5) * CELL;
  if (yCenter > FLOOR_CUTOFF_Y) break;
  for (let iz = 0; iz < gz; iz++) {
    for (let ix = 0; ix < gx; ix++) solid[cellIdx(ix, iy, iz)] = 0;
  }
}

let solidCount = 0;
for (const v of solid) if (v) solidCount++;
console.log(`Solid voxels (post-floor-strip): ${solidCount}`);

// Greedy box meshing: expand each unmerged solid cell into the largest
// axis-aligned cuboid of contiguous solids, mark them consumed, emit AABB.
const consumed = new Uint8Array(solid.length);
const aabbs = [];

const allSolid = (x0, x1, y0, y1, z0, z1) => {
  for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
    const i = cellIdx(ix, iy, iz);
    if (!solid[i] || consumed[i]) return false;
  }
  return true;
};

for (let iy = 0; iy < gy; iy++) {
  for (let iz = 0; iz < gz; iz++) {
    for (let ix = 0; ix < gx; ix++) {
      const i = cellIdx(ix, iy, iz);
      if (!solid[i] || consumed[i]) continue;
      let x1 = ix;
      while (x1 + 1 < gx && solid[cellIdx(x1 + 1, iy, iz)] && !consumed[cellIdx(x1 + 1, iy, iz)]) x1++;
      let z1 = iz;
      while (z1 + 1 < gz && allSolid(ix, x1, iy, iy, z1 + 1, z1 + 1)) z1++;
      let y1 = iy;
      while (y1 + 1 < gy && allSolid(ix, x1, y1 + 1, y1 + 1, iz, z1)) y1++;
      for (let yy = iy; yy <= y1; yy++) for (let zz = iz; zz <= z1; zz++) for (let xx = ix; xx <= x1; xx++) {
        consumed[cellIdx(xx, yy, zz)] = 1;
      }
      const cx = originX + (ix + (x1 - ix + 1) / 2) * CELL;
      const cy = originY + (iy + (y1 - iy + 1) / 2) * CELL;
      const cz = originZ + (iz + (z1 - iz + 1) / 2) * CELL;
      const hx = ((x1 - ix + 1) * CELL) / 2;
      const hy = ((y1 - iy + 1) * CELL) / 2;
      const hz = ((z1 - iz + 1) * CELL) / 2;
      aabbs.push({ pos: [cx, cy, cz], halfSize: [hx, hy, hz] });
    }
  }
}

console.log(`Merged AABBs: ${aabbs.length}`);

// Map perimeter for the runtime — pick the larger of X/Z so the perimeter
// safety clamp doesn't carve into playable space on a non-square map.
const perimeter = Math.ceil(Math.max(sizeX, sizeZ));

const fmt = (n) => Number(n.toFixed(4));
const lines = aabbs.map((a) => {
  const p = a.pos.map(fmt).join(', ');
  const h = a.halfSize.map(fmt).join(', ');
  return `  { pos: [${p}], halfSize: [${h}] },`;
});

const output = `// AUTO-GENERATED by scripts/extract-map-collision.mjs — do not edit.
// Source: Maps/fps_shooter_game_arena_map_v3/scene.gltf
// Voxel size: ${CELL} m  ·  AABBs: ${aabbs.length}
import type { Obstacle } from '../constants.js';

export const FPS_SHOOTER_OBSTACLES: readonly Obstacle[] = [
${lines.join('\n')}
];

export const FPS_SHOOTER_BOUNDS = {
  sizeX: ${fmt(sizeX)},
  sizeY: ${fmt(sizeY)},
  sizeZ: ${fmt(sizeZ)},
  perimeter: ${perimeter},
  // Translation applied to the source GLTF so its centered origin matches
  // the runtime collision data. Apply this to the rendered scene's position.
  offsetX: ${fmt(offsetX)},
  offsetY: ${fmt(offsetY)},
  offsetZ: ${fmt(offsetZ)},
};
`;

await writeFile(OUTPUT_TS, output);
console.log(`Wrote ${OUTPUT_TS}`);
