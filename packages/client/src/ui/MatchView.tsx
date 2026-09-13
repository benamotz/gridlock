import { useEffect, useRef, useState } from 'react';
import type { MatchConfig, SnapshotMsg } from '@gridlock/shared';
import { GameClient } from '../game/GameClient.js';
import type { ClientSocket } from '../net/ClientSocket.js';
import { useStore } from '../store.js';
import { HUD } from './HUD.js';
import { Scoreboard } from './Scoreboard.js';
import { SettingsPanel } from './Settings.js';

interface Props {
  socket: ClientSocket;
  mapId: string;
  config: MatchConfig;
  /** Registers the live client so App can forward snapshots to it. */
  onClient(client: GameClient | null): void;
  onLeave(): void;
}

/**
 * Hosts the canvas and owns the `GameClient` lifetime.
 *
 * React never re-renders per frame: the game loop draws straight to the canvas
 * and pushes a small HUD object into the store at snapshot rate, which is the
 * only thing the React tree above depends on.
 */
export function MatchView(props: Props): React.ReactElement {
  const worldRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<GameClient | null>(null);
  /** Wall-clock time the last snapshot reached the HUD. */
  const lastSnapshotAt = useRef(Date.now());
  const [mapExpanded, setMapExpanded] = useState(false);
  const [stalled, setStalled] = useState(false);
  const {
    settings, settingsOpen, showScoreboard, scoreboard, hud, status, set, pushKills,
  } = useStore();

  // The client is created once per match; changing settings updates it in place.
  useEffect(() => {
    const canvas = worldRef.current;
    const minimap = minimapRef.current;
    if (!canvas || !minimap) return undefined;

    const client = new GameClient(
      canvas, minimap, props.socket, props.mapId, props.config,
      useStore.getState().settings,
      {
        onHud: (state) => {
          set({ hud: state });
          pushKills(state.killFeed);
          lastSnapshotAt.current = Date.now();
        },
        onScoreboard: (down) => set({ showScoreboard: down }),
        onMenu: () => set({ settingsOpen: !useStore.getState().settingsOpen }),
        onChat: () => undefined,
      },
    );
    client.setPlayerId(useStore.getState().playerId);
    clientRef.current = client;
    props.onClient(client);
    client.start();

    return () => {
      client.stop();
      clientRef.current = null;
      props.onClient(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mapId]);

  useEffect(() => {
    clientRef.current?.applySettings(settings);
  }, [settings]);

  // If snapshots stop arriving the world simply stops updating, which looks
  // like a frozen or black screen. Say what is happening instead.
  useEffect(() => {
    const id = window.setInterval(() => {
      setStalled(Date.now() - lastSnapshotAt.current > 3000);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Input is suppressed whenever a menu is on top of the game.
  useEffect(() => {
    clientRef.current?.setInputEnabled(!settingsOpen);
  }, [settingsOpen]);

  const minimapSize = mapExpanded ? 620 : 190;

  return (
    <div className="match-root">
      <canvas className="world" ref={worldRef} />

      <div className={`minimap-wrap${mapExpanded ? ' expanded' : ''}`}>
        <canvas ref={minimapRef} width={minimapSize} height={minimapSize} />
      </div>

      <HUD
        mapExpanded={mapExpanded}
        connectionWarning={
          status === 'reconnecting' ? 'Reconnecting...'
            : status === 'failed' ? 'Connection lost'
              : null
        }
      />

      {showScoreboard && (
        <Scoreboard entries={scoreboard} teamScores={hud.teamScores} />
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => set({ settingsOpen: false })}
          onLeaveMatch={props.onLeave}
        />
      )}

      {stalled && (
        <div className="match-stalled">
          <div className="big">WAITING FOR THE SERVER</div>
          <div className="sub">
            {status === 'connected'
              ? 'No updates received. The match may have ended.'
              : 'Reconnecting...'}
          </div>
          <button className="btn" onClick={props.onLeave}>Return to menu</button>
        </div>
      )}

      <MapKeyBridge onToggle={() => setMapExpanded((v) => !v)} />
    </div>
  );
}

/**
 * The expanded-map toggle lives in React state (it resizes a DOM canvas), while
 * the key itself is captured by the input layer. This bridge keeps the two in
 * sync without giving the input layer a reference to React.
 */
function MapKeyBridge({ onToggle }: { onToggle(): void }): null {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.code === 'KeyM' && !e.repeat) onToggle();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onToggle]);
  return null;
}

export type { SnapshotMsg };
