import { getActiveMap, raycastObstacles, type MapId, type Vec3 } from '@slipstream/shared';

// Pathing graph derived from the active map's hand-authored or auto-generated
// waypoints + edge list. Built lazily on first request per map id, then
// cached — `setActiveMap()` flips the id and the next lookup rebuilds.

export interface NavGraph {
  readonly nodes: readonly Vec3[];
  readonly adj: readonly (readonly number[])[];
  readonly cost: readonly (readonly number[])[];
}

const dist3 = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const buildGraph = (
  nodes: readonly Vec3[],
  edges: readonly (readonly [number, number])[],
): NavGraph => {
  const n = nodes.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  const cost: number[][] = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (const [a, b] of edges) {
    if (a === b) continue;
    if (!adj[a]!.includes(b)) adj[a]!.push(b);
    if (!adj[b]!.includes(a)) adj[b]!.push(a);
    const d = dist3(nodes[a]!, nodes[b]!);
    cost[a]![b] = d;
    cost[b]![a] = d;
  }
  return { nodes, adj, cost };
};

const cache = new Map<MapId, NavGraph>();

export const getNavGraph = (): NavGraph => {
  const map = getActiveMap();
  let graph = cache.get(map.id);
  if (!graph) {
    graph = buildGraph(map.waypoints, map.edges);
    cache.set(map.id, graph);
  }
  return graph;
};

export const nearestReachableNode = (pos: Vec3): number => {
  const graph = getNavGraph();
  let bestIdx = 0;
  let bestDist = Infinity;
  let bestVisibleIdx = -1;
  let bestVisibleDist = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    const d = dist3(pos, node);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
    if (hasLineOfSight(pos, node)) {
      if (d < bestVisibleDist) {
        bestVisibleDist = d;
        bestVisibleIdx = i;
      }
    }
  }
  return bestVisibleIdx >= 0 ? bestVisibleIdx : bestIdx;
};

export const hasLineOfSight = (a: Vec3, b: Vec3): boolean => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-4) return true;
  const dir: Vec3 = [dx / len, dy / len, dz / len];
  const t = raycastObstacles(a, dir, len);
  return t === null;
};
