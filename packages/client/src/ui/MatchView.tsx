import { useEffect, useRef, useState } from 'react';
import type { MatchConfig, SnapshotMsg } from '@gridlock/shared';
import { GameClient } from '../game/GameClient.js';
import type { ClientSocket } from '../net/ClientSocket.js';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { HUD } from './HUD.js';
import { Scoreboard } from './Scoreboard.js';
import { SettingsPanel } from './Settings.js';
import { TouchHud } from './TouchHud.js';
import { CrewPanel } from './CrewPanel.js';
import { ShopPanel } from './ShopPanel.js';
import { touchEnabled } from '../game/touch/device.js';

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
  /** Hosts the touch thumb zones, between the world canvas and the HUD. */
  const touchRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<GameClient | null>(null);
  /** Wall-clock time the last snapshot reached the HUD. */
  const lastSnapshotAt = useRef(Date.now());
  const [mapExpanded, setMapExpanded] = useState(false);
  const [stalled, setStalled] = useState(false);
  // The shop menu opens when you walk in; closing it hides it until you
  // leave and come back.
  const shop = useStore((s) => s.hud.shop);
  const cash = useStore((s) => s.hud.cash);
  const [shopDismissed, setShopDismissed] = useState(false);
  useEffect(() => {
    if (!shop) setShopDismissed(false);
  }, [shop === null]);
  // The big map is sized to the window, and redrawn sharp when it changes.
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const {
    settings, settingsOpen, showScoreboard, showCrew, scoreboard, teamScores, status, set, pushKills,
  } = useStore(useShallow((s) => ({
    // Only what this view uses: the HUD's 15-a-second updates must not
    // re-render the canvas host and everything under it.
    settings: s.settings,
    settingsOpen: s.settingsOpen,
    showScoreboard: s.showScoreboard,
    showCrew: s.showCrew,
    scoreboard: s.scoreboard,
    teamScores: s.hud.teamScores,
    status: s.status,
    set: s.set,
    pushKills: s.pushKills,
  })));

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
        onCrew: () => set({ showCrew: !useStore.getState().showCrew }),
      },
    );
    client.setPlayerId(useStore.getState().playerId);
    client.attachTouch(touchRef.current);
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

  const touch = touchEnabled(settings.touchControls);
  // On a phone the map stays a corner widget and opens as an overlay that never
  // fills the screen.
  // Corner map, or the big map: on a phone nearly the whole screen, on a
  // desktop a large panel. Sized in CSS pixels; the canvas gets device pixels.
  const mapCss = mapExpanded
    ? touch
      ? { w: viewport.w - 24, h: viewport.h - 24 }
      : { w: Math.min(980, viewport.w - 120), h: Math.min(720, viewport.h - 120) }
    : touch ? { w: 140, h: 140 } : { w: 190, h: 190 };
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const rootClass = [
    'match-root',
    touch ? 'touch-ui' : '',
    touch && settings.leftHanded ? 'left-handed' : '',
    touch ? `btn-${settings.touchButtonSize}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass}>
      <canvas className="world" ref={worldRef} />
      <div className="touch-host" ref={touchRef} />

      <div className={`minimap-wrap${mapExpanded ? ' expanded' : ''}`}>
        <canvas
          ref={minimapRef}
          width={Math.round(mapCss.w * dpr)}
          height={Math.round(mapCss.h * dpr)}
          style={{ width: mapCss.w, height: mapCss.h }}
        />
      </div>

      <HUD
        mapExpanded={mapExpanded}
        connectionWarning={
          status === 'reconnecting' ? 'Reconnecting...'
            : status === 'failed' ? 'Connection lost'
              : null
        }
      />

      {touch && (
        <TouchHud
          client={() => clientRef.current}
          onToggleMap={() => {
            clientRef.current?.toggleMap();
            setMapExpanded((v) => !v);
          }}
          onToggleScoreboard={() => set({ showScoreboard: !useStore.getState().showScoreboard })}
          onMenu={() => set({ settingsOpen: !useStore.getState().settingsOpen })}
          onToggleCrew={() => set({ showCrew: !useStore.getState().showCrew })}
          mapExpanded={mapExpanded}
        />
      )}

      {shop && !shopDismissed && (
        <ShopPanel
          shop={shop}
          cash={cash}
          onBuy={(item) => clientRef.current?.buy(item)}
          onClose={() => setShopDismissed(true)}
        />
      )}

      {showCrew && props.config.mode === 'freeroam' && (
        <CrewPanel
          onCreate={() => clientRef.current?.crew('create')}
          onLeave={() => {
            clientRef.current?.crew('leave');
            set({ showCrew: false });
          }}
          onClose={() => set({ showCrew: false })}
        />
      )}

      {showScoreboard && (
        <Scoreboard
          entries={scoreboard}
          teamScores={teamScores}
          onClose={touch ? () => set({ showScoreboard: false }) : undefined}
        />
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
