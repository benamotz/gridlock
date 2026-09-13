import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MatchConfig, ServerMessage } from '@gridlock/shared';
import { ClientSocket, type ConnectionStatus } from '../net/ClientSocket.js';
import { useStore } from '../store.js';
import type { GameClient } from '../game/GameClient.js';
import { MainMenu } from './MainMenu.js';
import { Lobby } from './Lobby.js';
import { MatchView } from './MatchView.js';
import { Results } from './Results.js';
import { SettingsPanel } from './Settings.js';

/**
 * Application shell.
 *
 * Owns the socket, routes server messages into the store, and switches between
 * the menu, lobby, match and results screens as the room's phase changes.
 */
export function App(): React.ReactElement {
  const store = useStore();
  const { screen, settingsOpen, results, config, roomCode } = store;
  const clientRef = useRef<GameClient | null>(null);
  const [matchKey, setMatchKey] = useState(0);
  const [activeMap, setActiveMap] = useState<string | null>(null);

  const socket = useMemo(
    () =>
      new ClientSocket({
        onStatus: (status: ConnectionStatus, detail?: string) => {
          useStore.getState().set({ status, statusDetail: detail ?? '' });
        },
        onMessage: (msg: ServerMessage) => handleMessage(msg),
      }),
    [],
  );

  const handleMessage = useCallback((msg: ServerMessage): void => {
    const set = useStore.getState().set;
    switch (msg.t) {
      case 'welcome':
        set({
          playerId: msg.playerId,
          maps: msg.maps,
          error: null,
          screen: useStore.getState().screen === 'connecting'
            ? 'menu'
            : useStore.getState().screen,
        });
        break;

      case 'room_state': {
        const prev = useStore.getState();
        set({
          roomCode: msg.code,
          hostId: msg.hostId,
          isPrivate: msg.isPrivate,
          phase: msg.phase,
          config: msg.config,
          members: msg.members,
          countdownEndsAt: msg.countdownEndsAt ?? null,
          error: null,
        });
        // Back to the lobby after a match ends or a rematch is called.
        if (msg.phase === 'lobby' && prev.screen !== 'lobby') {
          set({ screen: 'lobby', results: null });
        }
        break;
      }

      case 'match_start':
        setActiveMap(msg.mapId);
        setMatchKey((k) => k + 1);
        set({ screen: 'match', config: msg.config, results: null, killFeed: [] });
        break;

      case 'snap':
        clientRef.current?.onSnapshot(msg);
        break;

      case 'deploy_result':
        clientRef.current?.onDeployResult(msg);
        break;

      case 'scoreboard':
        set({ scoreboard: msg.entries });
        break;

      case 'match_end':
        set({ results: msg, screen: 'results', scoreboard: msg.entries });
        break;

      case 'chat':
        useStore.getState().pushChat({
          from: msg.from, team: msg.team, text: msg.text, at: Date.now(),
        });
        break;

      case 'error':
        set({ error: msg.message });
        break;

      case 'kicked':
        set({ error: msg.reason, screen: 'menu' });
        break;
    }
  }, []);

  useEffect(() => {
    socket.connect(socket.displayName || 'Guest');
    return () => socket.disconnect();
  }, [socket]);

  // The scoreboard is served on demand; refresh it while it is held open.
  useEffect(() => {
    if (!store.showScoreboard || screen !== 'match') return undefined;
    socket.send({ t: 'scoreboard' });
    const id = window.setInterval(() => socket.send({ t: 'scoreboard' }), 1000);
    return () => window.clearInterval(id);
  }, [store.showScoreboard, screen, socket]);

  const leaveToMenu = useCallback((): void => {
    socket.send({ t: 'leave_room' });
    useStore.getState().set({
      screen: 'menu', roomCode: null, results: null, settingsOpen: false,
    });
  }, [socket]);

  return (
    <div className="shell">
      <div className="screen">
        {screen === 'connecting' && (
          <div className="centered">
            <div className="card" style={{ textAlign: 'center' }}>
              <h1 className="brand">GRIDLOCK</h1>
              <p className="tagline">Connecting</p>
            </div>
          </div>
        )}

        {screen === 'menu' && (
          <MainMenu
            onQuickPlay={() => socket.send({ t: 'quick_play' })}
            onCreate={(cfg, isPrivate) =>
              socket.send({ t: 'create_room', config: cfg, isPrivate })}
            onJoin={(code) => socket.send({ t: 'join_room', code })}
            onPractice={() => socket.send({ t: 'practice', config: {} })}
            onOpenSettings={() => useStore.getState().set({ settingsOpen: true })}
            onChangeName={(name) => {
              socket.setDisplayName(name);
              useStore.getState().set({ displayName: name });
              socket.send({ t: 'set_name', name });
            }}
          />
        )}

        {screen === 'lobby' && (
          <Lobby
            onSetTeam={(team) => socket.send({ t: 'set_team', team })}
            onReady={(ready) => socket.send({ t: 'set_ready', ready })}
            onStart={() => socket.send({ t: 'start_match' })}
            onLeave={leaveToMenu}
            onUpdateConfig={(patch: Partial<MatchConfig>) =>
              socket.send({ t: 'update_config', config: patch })}
          />
        )}

        {screen === 'match' && activeMap && (
          <MatchView
            key={matchKey}
            socket={socket}
            mapId={activeMap}
            config={config}
            onClient={(c) => { clientRef.current = c; }}
            onLeave={leaveToMenu}
          />
        )}

        {screen === 'results' && results && (
          <Results
            results={results}
            onRematch={() => socket.send({ t: 'rematch' })}
            onLobby={() => useStore.getState().set({ screen: 'lobby' })}
            onMenu={leaveToMenu}
          />
        )}
      </div>

      {settingsOpen && screen !== 'match' && (
        <SettingsPanel onClose={() => useStore.getState().set({ settingsOpen: false })} />
      )}

      {roomCode && screen === 'match' && null}
    </div>
  );
}
