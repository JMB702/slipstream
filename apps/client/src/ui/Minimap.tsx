import { MAPS } from '@slipstream/shared';
import { useGame } from '../store.js';

const SIZE = 160;

export const Minimap = () => {
  const myId = useGame((s) => s.myId);
  const mapId = useGame((s) => s.activeMapId);
  const lastSnap = useGame((s) => s.snapshots[s.snapshots.length - 1]);
  const map = MAPS[mapId];
  const scale = SIZE / map.size;
  const worldToMap = (x: number, z: number) => ({
    x: x * scale + SIZE / 2,
    // Screen-y inverted vs world-z so forward (-z at yaw=0) reads as "up".
    y: -z * scale + SIZE / 2,
  });
  if (!myId || !lastSnap) return null;
  const me = lastSnap.players.get(myId);
  if (!me) return null;

  const others = Array.from(lastSnap.players.values()).filter((p) => p.id !== myId);
  const playerCount = lastSnap.players.size;
  const my = worldToMap(me.position[0], me.position[2]);
  // World yaw rotates forward from -z toward -x as yaw grows (right-handed
  // around +y). After flipping z to screen-y, that becomes a clockwise
  // rotation in screen space, and SVG rotate() is also clockwise — but we
  // negate because the triangle is drawn pointing screen-up (which corresponds
  // to world -z), so the arrow follows yaw directly without sign flip.
  const yawDeg = (-me.yaw * 180) / Math.PI;

  return (
    <div style={containerStyle}>
      <div style={badgeStyle}>
        {playerCount === 1
          ? 'Alone in room'
          : `${others.filter((p) => p.alive).length} enemy · ${playerCount} in room`}
      </div>
      <svg width={SIZE} height={SIZE} style={mapStyle}>
      <rect width={SIZE} height={SIZE} fill="rgba(8,10,18,0.75)" />
      {map.obstacles.map((o, i) => {
        const c = worldToMap(o.pos[0], o.pos[2]);
        const w = o.halfSize[0] * 2 * scale;
        const h = o.halfSize[2] * 2 * scale;
        return (
          <rect
            key={i}
            x={c.x - w / 2}
            y={c.y - h / 2}
            width={w}
            height={h}
            fill="#444a66"
          />
        );
      })}
      {others.map((p) => {
        const c = worldToMap(p.position[0], p.position[2]);
        const fill = p.alive ? '#ff4d4d' : 'transparent';
        return (
          <circle
            key={p.id}
            cx={c.x}
            cy={c.y}
            r={5}
            fill={fill}
            stroke={p.alive ? '#000' : '#ff4d4d'}
            strokeWidth={p.alive ? 1 : 1.5}
          />
        );
      })}
      <g transform={`translate(${my.x},${my.y}) rotate(${yawDeg})`}>
        <polygon points="0,-6 5,5 -5,5" fill="#5fff8f" stroke="#000" strokeWidth={1} />
      </g>
      </svg>
    </div>
  );
};

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
  pointerEvents: 'none',
};

const badgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  color: '#e8e8f0',
  background: 'rgba(0,0,0,0.55)',
  padding: '3px 8px',
  borderRadius: 3,
};

const mapStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 4,
};
