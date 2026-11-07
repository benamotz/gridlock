import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type MatchConfig, type ServerMessage, normalizeCrewCode } from '@gridlock/shared';
import { ClientSocket, type ConnectionStatus } from '../net/ClientSocket.js';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import type { GameClient } from '../game/GameClient.js';
import { MainMenu } from './MainMenu.js';
import { Lobby } from './Lobby.js';
import { MatchView } from './MatchView.js';
import { Results } from './Results.js';
import { SettingsPanel } from './Settings.js';
import { touchEnabled } from '../game/touch/device.js';
import { installAutoFullscreen } from '../game/touch/fullscreen.js';

// Phones go full screen (and lock landscape) on their first tap anywhere.
installAutoFullscreen(() => touchEnabled(useStore.getState().settings.touchControls));

/**
 * Application shell.
 *
 * Owns the socket, routes server messages into the store, and switches between
 * the menu, lobby, match and results screens as the room's phase changes.
 */
/**
 * A crew invite link (`/?crew=CODE`) is read once, on load: the first time the
 * server says hello, the player goes straight into the city and joins that
 * crew. The code is then taken out of the address so a later reload or
 * bookmark does not try to rejoin a crew that may be long gone.
 */
let pendingCrew: string | null = (() => {
  try {
    const url = new URL(window.location.href);
    const code = normalizeCrewCode(url.searchParams.get('crew') ?? '');
    if (url.searchParams.has('crew')) {
      url.searchParams.delete('crew');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return code || null;
  } catch {
    return null;
  }
})();

export function App(): React.ReactElement {
  // Only what this component renders from. Subscribing to the whole store made
  // the entire app re-render on every HUD update (15 a second) - a real cost
  // on phones.
  const { screen, settingsOpen, results, config, roomCode, showScoreboard, touchSetting } = useStore(
    useShallow((s) => ({
      touchSetting: s.settings.touchControls,
      screen: s.screen,
      settingsOpen: s.settingsOpen,
      results: s.results,
      config: s.config,
      roomCode: s.roomCode,
      showScoreboard: s.showScoreboard,
    })),
  );
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
        if (pendingCrew) {
          socket.send({ t: 'free_roam', crew: pendingCrew });
          pendingCrew = null;
        }
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
    if (!showScoreboard || screen !== 'match') return undefined;
    socket.send({ t: 'scoreboard' });
    const id = window.setInterval(() => socket.send({ t: 'scoreboard' }), 1000);
    return () => window.clearInterval(id);
  }, [showScoreboard, screen, socket]);

  const leaveToMenu = useCallback((): void => {
    socket.send({ t: 'leave_room' });
    useStore.getState().set({
      screen: 'menu', roomCode: null, results: null, settingsOpen: false,
    });
  }, [socket]);

  return (
    <div className={`shell${touchEnabled(touchSetting) ? ' touch-device' : ''}`}>
      {/* Phones play sideways on every screen, menus included. */}
      <div className="app-rotate" aria-hidden={false}>
        <div className="app-rotate-icon">⟳</div>
        Turn your phone sideways to play
      </div>
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
            onFreeRoam={() => socket.send({ t: 'free_roam' })}
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
