import { useState } from 'react';
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from '@gridlock/shared';
import { useStore } from '../store.js';

interface Props {
  onQuickPlay(): void;
  onCreate(config: Partial<MatchConfig>, isPrivate: boolean): void;
  onJoin(code: string): void;
  onPractice(): void;
  onOpenSettings(): void;
  onChangeName(name: string): void;
}

type Panel = 'main' | 'create' | 'join';

export function MainMenu(props: Props): React.ReactElement {
  const { maps, displayName, error, status, statusDetail } = useStore();
  const [panel, setPanel] = useState<Panel>('main');
  const [name, setName] = useState(displayName);
  const [code, setCode] = useState('');
  const [config, setConfig] = useState<MatchConfig>({ ...DEFAULT_MATCH_CONFIG });

  const commitName = (): void => {
    const trimmed = name.trim();
    if (trimmed) props.onChangeName(trimmed);
  };

  return (
    <div className="centered">
      <div className="card">
        <h1 className="brand">GRIDLOCK</h1>
        <p className="tagline">Top-down urban team combat</p>

        {status !== 'connected' && (
          <p className="hint" style={{ marginBottom: 14 }}>
            {status === 'connecting' && 'Connecting to the server...'}
            {status === 'reconnecting' && `Reconnecting. ${statusDetail}`}
            {status === 'failed' && 'Server unreachable. Is it running on port 2567?'}
            {status === 'disconnected' && 'Disconnected.'}
          </p>
        )}
        {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

        <div className="row" style={{ marginBottom: 18 }}>
          <div className="field grow">
            <label htmlFor="name">Display name</label>
            <input
              id="name"
              type="text"
              value={name}
              maxLength={18}
              placeholder="Guest"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
            />
          </div>
          <button className="btn ghost" onClick={props.onOpenSettings}>Settings</button>
        </div>

        {panel === 'main' && (
          <div className="menu-grid">
            <button
              className="btn primary big"
              disabled={status !== 'connected'}
              onClick={() => { commitName(); props.onQuickPlay(); }}
            >
              Quick Match
            </button>
            <button
              className="btn big"
              disabled={status !== 'connected'}
              onClick={() => { commitName(); setPanel('create'); }}
            >
              Create Private Match
            </button>
            <button
              className="btn big"
              disabled={status !== 'connected'}
              onClick={() => { commitName(); setPanel('join'); }}
            >
              Join by Code
            </button>
            <button
              className="btn big"
              disabled={status !== 'connected'}
              onClick={() => { commitName(); props.onPractice(); }}
            >
              Single-Player Practice
            </button>
          </div>
        )}

        {panel === 'join' && (
          <div className="col">
            <div className="field">
              <label htmlFor="code">Room code</label>
              <input
                id="code"
                className="code-input"
                type="text"
                value={code}
                maxLength={5}
                placeholder="ABCDE"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.length >= 4) props.onJoin(code);
                }}
              />
            </div>
            <div className="row">
              <button
                className="btn primary"
                disabled={code.length < 4}
                onClick={() => props.onJoin(code)}
              >
                Join Match
              </button>
              <button className="btn ghost" onClick={() => setPanel('main')}>Back</button>
            </div>
          </div>
        )}

        {panel === 'create' && (
          <div className="col">
            <p className="section-title">Map</p>
            <div className="map-picker">
              {maps.map((m) => (
                <button
                  key={m.id}
                  className={`map-card${config.mapId === m.id ? ' active' : ''}`}
                  onClick={() => setConfig({ ...config, mapId: m.id })}
                >
                  <h5>{m.name}</h5>
                  <p>
                    {m.width}x{m.height} · up to {m.maxTeams} teams · best with{' '}
                    {m.recommendedPlayers}
                  </p>
                </button>
              ))}
            </div>

            <div className="divider" />

            <div className="settings-list">
              <div className="settings-row">
                <span>Teams</span>
                <select
                  value={config.teamCount}
                  onChange={(e) => setConfig({ ...config, teamCount: Number(e.target.value) })}
                >
                  {[2, 3, 4].map((n) => <option key={n} value={n}>{n} teams</option>)}
                </select>
              </div>
              <div className="settings-row">
                <span>Players per team</span>
                <select
                  value={config.teamSize}
                  onChange={(e) => setConfig({ ...config, teamSize: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="settings-row">
                <span>Score target</span>
                <select
                  value={config.scoreTarget}
                  onChange={(e) => setConfig({ ...config, scoreTarget: Number(e.target.value) })}
                >
                  {[15, 25, 40, 60].map((n) => <option key={n} value={n}>{n} kills</option>)}
                </select>
              </div>
              <div className="settings-row">
                <span>Match length</span>
                <select
                  value={config.matchDurationSec}
                  onChange={(e) => setConfig({ ...config, matchDurationSec: Number(e.target.value) })}
                >
                  {[300, 600, 720, 900].map((n) => (
                    <option key={n} value={n}>{n / 60} minutes</option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <span>Starting loadout</span>
                <select
                  value={config.loadoutRule}
                  onChange={(e) => setConfig({
                    ...config, loadoutRule: e.target.value as MatchConfig['loadoutRule'],
                  })}
                >
                  <option value="fixed">Fixed sidearm</option>
                  <option value="random-tier">Random (balanced tier)</option>
                  <option value="team-pool">Team pool</option>
                  <option value="none">No starting weapon</option>
                  <option value="chaos">Chaos (unbalanced)</option>
                </select>
              </div>
              <div className="settings-row">
                <span>Bot difficulty</span>
                <select
                  value={config.botDifficulty}
                  onChange={(e) => setConfig({
                    ...config, botDifficulty: e.target.value as MatchConfig['botDifficulty'],
                  })}
                >
                  <option value="easy">Easy</option>
                  <option value="normal">Normal</option>
                  <option value="hard">Hard</option>
                </select>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={config.botsEnabled}
                  onChange={(e) => setConfig({ ...config, botsEnabled: e.target.checked })}
                />
                Fill empty slots with bots
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={config.vehiclesEnabled}
                  onChange={(e) => setConfig({ ...config, vehiclesEnabled: e.target.checked })}
                />
                Vehicles enabled
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={config.friendlyFire}
                  onChange={(e) => setConfig({ ...config, friendlyFire: e.target.checked })}
                />
                Friendly fire
              </label>
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={() => props.onCreate(config, true)}>
                Create Private Room
              </button>
              <button className="btn" onClick={() => props.onCreate(config, false)}>
                Create Public Room
              </button>
              <button className="btn ghost" onClick={() => setPanel('main')}>Back</button>
            </div>
          </div>
        )}

        <div className="divider" />
        <div className="controls-grid">
          <div><span>Move</span> <span className="kbd">WASD</span></div>
          <div><span>Aim / Fire</span> <span className="kbd">Mouse</span></div>
          <div><span>Sprint</span> <span className="kbd">Shift</span></div>
          <div><span>Reload</span> <span className="kbd">R</span></div>
          <div><span>Enter / exit vehicle</span> <span className="kbd">E</span></div>
          <div><span>Swap weapon</span> <span className="kbd">F</span></div>
          <div><span>Weapon slots</span> <span className="kbd">1-4 / Wheel</span></div>
          <div><span>Scoreboard</span> <span className="kbd">Tab</span></div>
          <div><span>Jump (dodge bullets)</span> <span className="kbd">Space</span></div>
          <div><span>Use medkit / armor</span> <span className="kbd">H / G</span></div>
          <div><span>Barricade / sentry / mine</span> <span className="kbd">Q / T / X</span></div>
          <div><span>Rotate barricade</span> <span className="kbd">Wheel</span></div>
          <div><span>Expand map</span> <span className="kbd">M</span></div>
          <div><span>Menu</span> <span className="kbd">Esc</span></div>
        </div>
      </div>
    </div>
  );
}
