import type { Vec3 } from '@slipstream/shared';
import { NAV_GRAPH, hasLineOfSight, nearestReachableNode } from './waypoints.js';

// A* over the small (16-node) waypoint graph. Returns a list of world-space
// positions from start → goal, or null if unreachable. Caller passes the
// bot's current position and the desired destination — we snap each end to
// the nearest reachable graph node and stitch the result.
export const planPath = (start: Vec3, goal: Vec3): Vec3[] | null => {
  // If we already have direct LOS to the goal, no graph search needed.
  if (hasLineOfSight(start, goal)) return [goal];

  const startIdx = nearestReachableNode(start);
  const goalIdx = nearestReachableNode(goal);
  if (startIdx === goalIdx) {
    return [NAV_GRAPH.nodes[startIdx]!, goal];
  }

  const nodeIdxPath = aStar(startIdx, goalIdx);
  if (nodeIdxPath === null) return null;

  const out: Vec3[] = [];
  for (const i of nodeIdxPath) out.push(NAV_GRAPH.nodes[i]!);
  // Append the original goal so the bot finishes at the actual target spot,
  // not just the nearest waypoint.
  out.push(goal);
  return out;
};

const aStar = (startIdx: number, goalIdx: number): number[] | null => {
  const n = NAV_GRAPH.nodes.length;
  const goalPos = NAV_GRAPH.nodes[goalIdx]!;
  const gScore = new Array<number>(n).fill(Infinity);
  const fScore = new Array<number>(n).fill(Infinity);
  const cameFrom = new Array<number>(n).fill(-1);
  const open = new Set<number>();

  gScore[startIdx] = 0;
  fScore[startIdx] = heuristic(NAV_GRAPH.nodes[startIdx]!, goalPos);
  open.add(startIdx);

  while (open.size > 0) {
    // n=16 — scan-the-set is fine; a heap would be overkill.
    let current = -1;
    let bestF = Infinity;
    for (const i of open) {
      if (fScore[i]! < bestF) {
        bestF = fScore[i]!;
        current = i;
      }
    }
    if (current === -1) return null;

    if (current === goalIdx) {
      const path: number[] = [];
      let cur = current;
      while (cur !== -1) {
        path.push(cur);
        cur = cameFrom[cur]!;
      }
      path.reverse();
      return path;
    }

    open.delete(current);
    const adj = NAV_GRAPH.adj[current]!;
    for (const neighbor of adj) {
      const tentative = gScore[current]! + NAV_GRAPH.cost[current]![neighbor]!;
      if (tentative < gScore[neighbor]!) {
        cameFrom[neighbor] = current;
        gScore[neighbor] = tentative;
        fScore[neighbor] = tentative + heuristic(NAV_GRAPH.nodes[neighbor]!, goalPos);
        open.add(neighbor);
      }
    }
  }
  return null;
};

const heuristic = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
};

// Pick a random patrol destination from the waypoint set, excluding any node
// closer than `minDistance` to the bot's current position.
export const randomPatrolGoal = (from: Vec3, minDistance = 8): Vec3 => {
  const candidates: Vec3[] = [];
  for (const n of NAV_GRAPH.nodes) {
    const dx = n[0] - from[0];
    const dz = n[2] - from[2];
    if (dx * dx + dz * dz >= minDistance * minDistance) candidates.push(n);
  }
  const pool = candidates.length > 0 ? candidates : NAV_GRAPH.nodes;
  return pool[Math.floor(Math.random() * pool.length)]!;
};
