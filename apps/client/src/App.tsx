import { useEffect, useState } from 'react';
import { setActiveMap, type BotDifficulty, type MapId } from '@slipstream/shared';
import { connect, type NetClient } from './net/client.js';
import { Scene } from './game/Scene.js';
import { Lobby } from './ui/Lobby.js';
import { HUD } from './ui/HUD.js';
import { Minimap } from './ui/Minimap.js';
import { Scoreboard } from './ui/Scoreboard.js';
import { useGame } from './store.js';

export const App = () => {
  const [client, setClient] = useState<NetClient | null>(null);
  const [name, setName] = useState('');
  const lastCloseReason = useGame((s) => s.lastCloseReason);

  const onJoin = ({
    name,
    mapId,
    killTarget,
    accessCode,
    botCount,
    botDifficulty,
  }: {
    name: string;
    mapId: MapId;
    killTarget: number;
    accessCode: string;
    botCount: number;
    botDifficulty: BotDifficulty;
  }) => {
    setActiveMap(mapId);
    useGame.getState().setActiveMapId(mapId);
    const c = connect(mapId, name, killTarget, accessCode, botCount, botDifficulty);
    setClient(c);
    setName(name);
  };

  const onLeave = () => {
    client?.close();
    setClient(null);
    useGame.getState().reset();
  };

  // If the server hard-rejected us (bad access code, room full), drop back to
  // the lobby automatically. Without this the player sits on a black canvas
  // staring at "● disconnected" with no idea what went wrong.
  useEffect(() => {
    if (client && lastCloseReason) {
      client.close();
      setClient(null);
    }
  }, [client, lastCloseReason]);

  if (!client) return <Lobby onJoin={onJoin} />;

  return (
    <>
      <Scene send={client.send} myName={name} />
      <HUD />
      <Minimap />
      <Scoreboard />
      <button onClick={onLeave} style={leaveBtn}>
        Leave
      </button>
    </>
  );
};

const leaveBtn: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  left: 12,
  padding: '6px 10px',
  background: 'rgba(0,0,0,0.5)',
  color: '#e8e8f0',
  border: '1px solid #2a2f4a',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
