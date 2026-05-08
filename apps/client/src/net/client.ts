import PartySocket from 'partysocket';
import {
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@slipstream/shared';
import { useGame } from '../store.js';

const urlHost =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('host')
    : null;
const HOST = urlHost || import.meta.env.VITE_PARTYKIT_HOST || 'localhost:1999';

export interface NetClient {
  socket: PartySocket;
  send(msg: ClientMessage): void;
  close(): void;
}

export const connect = (
  room: string,
  name: string,
  killTarget?: number,
  accessCode?: string,
): NetClient => {
  const store = useGame.getState();
  store.setConn('connecting');
  store.setCloseReason(null);

  const query: Record<string, string> = { name };
  if (killTarget != null && Number.isFinite(killTarget)) {
    query.killTarget = String(Math.floor(killTarget));
  }
  if (accessCode) {
    query.accessCode = accessCode;
  }

  const socket = new PartySocket({
    host: HOST,
    room,
    party: 'main',
    query,
  });

  socket.addEventListener('open', () => {
    useGame.getState().setConn('connected');
  });

  socket.addEventListener('close', (event) => {
    // Server uses 4003 for a bad access code. PartySocket auto-reconnects on
    // most close codes; we only surface a reason when it's a hard rejection
    // the player can actually fix in the lobby.
    const code = (event as CloseEvent).code;
    const reason = (event as CloseEvent).reason;
    if (code === 4003) {
      useGame.getState().setCloseReason(reason || 'invalid access code');
    } else if (code === 4001) {
      useGame.getState().setCloseReason(reason || 'room full');
    }
    useGame.getState().setConn('disconnected');
  });

  socket.addEventListener('message', (event) => {
    let msg: ServerMessage;
    try {
      msg = decode<ServerMessage>(event.data as string);
    } catch {
      return;
    }
    const s = useGame.getState();
    switch (msg.type) {
      case 'welcome':
        s.setMyId(msg.you);
        return;
      case 'snapshot':
        s.ingestSnapshot(msg.snapshot);
        return;
      case 'events':
        s.ingestEvents(msg.events);
        return;
      case 'pong':
        return;
    }
  });

  return {
    socket,
    send(msg) {
      socket.send(encode(msg));
    },
    close() {
      socket.close();
    },
  };
};
