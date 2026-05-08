import { useEffect, useRef, useState } from 'react';
import { useGame } from '../store.js';
import { PLAYER, WEAPON, type KillEvent } from '@slipstream/shared';

const HIT_MARKER_MS = 250;

export const HUD = () => {
  const myId = useGame((s) => s.myId);
  const lastSnap = useGame((s) => s.snapshots[s.snapshots.length - 1]);
  const killFeed = useGame((s) => s.killFeed);
  const conn = useGame((s) => s.conn);
  const me = myId ? lastSnap?.players.get(myId) : undefined;

  // Hit marker: brief X overlay around the crosshair when one of MY shots
  // landed on someone. Subscribed-via-store so we react to shot events as
  // they arrive instead of waiting for a re-render.
  const [hitAt, setHitAt] = useState(0);
  // Timestamp-based "what's new" tracking. The store caps events at 200, so
  // length-based comparison silently breaks after ~200 events: length stays
  // pinned and the subscriber stops firing. Server-assigned `at` is monotonic
  // per event, so it's safe to gate on.
  const lastAtRef = useRef<number>(-1);
  useEffect(() => {
    if (!myId) return;
    // Don't replay events that existed before this player got their id.
    const initial = useGame.getState().events;
    lastAtRef.current = initial.length ? Math.max(...initial.map((e) => e.at)) : -1;
    return useGame.subscribe((state) => {
      let hitMine = false;
      let maxAt = lastAtRef.current;
      for (const ev of state.events) {
        if (ev.at <= lastAtRef.current) continue;
        if (ev.at > maxAt) maxAt = ev.at;
        if (ev.type === 'shot' && ev.shooterId === myId && ev.hit !== null) {
          hitMine = true;
        }
      }
      lastAtRef.current = maxAt;
      if (hitMine) setHitAt(performance.now());
    });
  }, [myId]);

  // Auto-clear after HIT_MARKER_MS so the marker fades out.
  useEffect(() => {
    if (!hitAt) return;
    const t = setTimeout(() => setHitAt(0), HIT_MARKER_MS);
    return () => clearTimeout(t);
  }, [hitAt]);

  const showHitMarker = hitAt > 0;

  return (
    <>
      <div style={crosshairOuter}>
        <div style={crosshair} />
        {showHitMarker && <HitMarker />}
      </div>

      <div style={statusBar}>
        <span style={{ color: connColor(conn) }}>● {conn}</span>
        {me && (
          <>
            {me.health < PLAYER.maxHealth && <HealthBar health={me.health} />}
            <span>
              AMMO {me.ammo}/{WEAPON.magazineSize}
              {me.reloading && ' (reloading...)'}
            </span>
            <span>K {me.kills}</span>
            <span>D {me.deaths}</span>
          </>
        )}
      </div>

      {me && !me.alive && (
        <div style={deathOverlay}>
          <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>You died</div>
          <div style={{ opacity: 0.8 }}>Respawning…</div>
        </div>
      )}

      <div style={killFeedStyle}>
        {killFeed
          .filter((e): e is KillEvent => e.type === 'kill')
          .slice(-5)
          .reverse()
          .map((k, i) => (
            <KillRow key={`${k.at}-${i}`} kill={k} />
          ))}
      </div>
    </>
  );
};

// Four short ticks arranged in an X around the crosshair — classic hit-marker
// look. Lives inside the crosshairOuter (already centered on screen) and
// uses absolute positioning to fan out from the center.
const HitMarker = () => (
  <>
    <div style={{ ...hitTick, transform: 'translate(-50%, -50%) rotate(45deg) translate(0, -10px)' }} />
    <div style={{ ...hitTick, transform: 'translate(-50%, -50%) rotate(45deg) translate(0, 10px)' }} />
    <div style={{ ...hitTick, transform: 'translate(-50%, -50%) rotate(-45deg) translate(0, -10px)' }} />
    <div style={{ ...hitTick, transform: 'translate(-50%, -50%) rotate(-45deg) translate(0, 10px)' }} />
  </>
);

const HealthBar = ({ health }: { health: number }) => {
  const frac = Math.max(0, Math.min(1, health / PLAYER.maxHealth));
  const color = frac > 0.6 ? '#5fff8f' : frac > 0.3 ? '#ffd060' : '#ff5050';
  return (
    <span style={healthBarOuter} aria-label={`Health ${Math.round(health)}`}>
      <span style={{ ...healthBarFill, width: `${frac * 100}%`, background: color }} />
    </span>
  );
};

const KillRow = ({ kill }: { kill: KillEvent }) => {
  const lastSnap = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
  const killerName = kill.killerId
    ? lastSnap?.players.get(kill.killerId)?.name ?? 'Someone'
    : 'World';
  const victimName = lastSnap?.players.get(kill.victimId)?.name ?? 'Someone';
  return (
    <div style={killRow}>
      <span style={{ color: '#9bdcff' }}>{killerName}</span>
      <span style={{ opacity: 0.6 }}> → </span>
      <span style={{ color: '#ff9090' }}>{victimName}</span>
    </div>
  );
};

const connColor = (s: string) =>
  s === 'connected' ? '#5fff8f' : s === 'connecting' ? '#ffd060' : '#ff7070';

const crosshairOuter: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  pointerEvents: 'none',
};

const crosshair: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.85)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
};

const hitTick: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 2,
  height: 8,
  background: '#ffe080',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.7)',
  borderRadius: 1,
};

const statusBar: React.CSSProperties = {
  position: 'fixed',
  left: 16,
  bottom: 16,
  display: 'flex',
  gap: 16,
  fontSize: 14,
  background: 'rgba(0,0,0,0.4)',
  padding: '8px 14px',
  borderRadius: 4,
  pointerEvents: 'none',
  fontFamily: 'ui-monospace, monospace',
};

const deathOverlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(40, 0, 0, 0.45)',
  pointerEvents: 'none',
  textAlign: 'center',
};

const killFeedStyle: React.CSSProperties = {
  position: 'fixed',
  right: 16,
  top: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  pointerEvents: 'none',
  fontFamily: 'ui-monospace, monospace',
};

const healthBarOuter: React.CSSProperties = {
  display: 'inline-block',
  width: 140,
  height: 4,
  background: '#3a0a0a',
  border: '1px solid rgba(0,0,0,0.7)',
  borderRadius: 2,
  overflow: 'hidden',
  verticalAlign: 'middle',
};

const healthBarFill: React.CSSProperties = {
  display: 'block',
  height: '100%',
  transition: 'width 120ms linear, background 200ms linear',
};

const killRow: React.CSSProperties = {
  background: 'rgba(0,0,0,0.5)',
  padding: '4px 10px',
  borderRadius: 3,
  fontSize: 13,
};
