import { TEAM_PRESETS, type MatchConfig } from '@gridlock/shared';
import { useStore } from '../store.js';
import { teamColorFor } from '../render/assets.js';

interface Props {
  onSetTeam(team: number): void;
  onReady(ready: boolean): void;
  onStart(): void;
  onLeave(): void;
  onUpdateConfig(patch: Partial<MatchConfig>): void;
}

export function Lobby(props: Props): React.ReactElement {
  const {
    roomCode, hostId, playerId, config, members, maps, isPrivate,
    phase, countdownEndsAt, settings,
  } = useStore();

  const isHost = playerId !== null && playerId === hostId;
  const me = members.find((m) => m.playerId === playerId);
  const humans = members.filter((m) => !m.isBot);
  const countdown = countdownEndsAt
    ? Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000))
    : null;

  return (
    <div className="centered">
      <div className="card">
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="grow">
            <h2 style={{ margin: 0, letterSpacing: '0.08em' }}>MATCH LOBBY</h2>
            <p className="hint" style={{ margin: '4px 0 0' }}>
              {isPrivate ? 'Private room' : 'Public room'} ·{' '}
              {maps.find((m) => m.id === config.mapId)?.name ?? config.mapId} ·{' '}
              Team Deathmatch
            </p>
          </div>
          <button className="btn ghost" onClick={props.onLeave}>Leave</button>
        </div>

        {phase === 'countdown' && (
          <div className="roomcode" style={{ marginBottom: 16, color: 'var(--good)' }}>
            STARTING IN {countdown ?? 0}
          </div>
        )}

        <div className="lobby-grid">
          <div>
            <p className="section-title">Teams</p>
            <div className="team-columns">
              {Array.from({ length: config.teamCount }).map((_, team) => {
                const roster = members.filter((m) => m.team === team);
                const color = teamColorFor(team, settings.colorblind);
                return (
                  <div
                    key={team}
                    className="team-panel"
                    style={{ '--team': color } as React.CSSProperties}
                  >
                    <h4>
                      <span className="team-badge">{TEAM_PRESETS[team].symbol}</span>
                      {TEAM_PRESETS[team].name}
                      <span className="hint" style={{ marginLeft: 'auto' }}>
                        {roster.length}/{config.teamSize}
                      </span>
                    </h4>
                    {roster.map((m) => (
                      <div
                        key={m.playerId}
                        className={`member${m.playerId === playerId ? ' you' : ''}`}
                      >
                        <span className="grow">{m.name}</span>
                        {m.isHost && <span className="tag host">HOST</span>}
                        {m.isBot && <span className="tag bot">BOT</span>}
                        {m.connection === 'reconnecting' && (
                          <span className="tag away">AWAY</span>
                        )}
                        {!m.isBot && m.ready && <span className="tag">READY</span>}
                      </div>
                    ))}
                    {roster.length === 0 && <p className="hint">Empty</p>}
                    {phase === 'lobby' && me?.team !== team && (
                      <button
                        className="btn ghost wide"
                        style={{ marginTop: 4, padding: '6px 10px', fontSize: 12 }}
                        disabled={roster.filter((r) => !r.isBot).length >= config.teamSize}
                        onClick={() => props.onSetTeam(team)}
                      >
                        Join team
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="divider" />
            <p className="section-title">Match settings {isHost ? '' : '(host only)'}</p>
            <div className="settings-list">
              <div className="settings-row">
                <span>Map</span>
                <select
                  disabled={!isHost || phase !== 'lobby'}
                  value={config.mapId}
                  onChange={(e) => props.onUpdateConfig({ mapId: e.target.value })}
                >
                  {maps.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div className="settings-row">
                <span>Teams</span>
                <select
                  disabled={!isHost || phase !== 'lobby'}
                  value={config.teamCount}
                  onChange={(e) => props.onUpdateConfig({ teamCount: Number(e.target.value) })}
                >
                  {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="settings-row">
                <span>Score target</span>
                <select
                  disabled={!isHost || phase !== 'lobby'}
                  value={config.scoreTarget}
                  onChange={(e) => props.onUpdateConfig({ scoreTarget: Number(e.target.value) })}
                >
                  {[15, 25, 40, 60].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="settings-row">
                <span>Bots fill empty slots</span>
                <input
                  type="checkbox"
                  disabled={!isHost || phase !== 'lobby'}
                  checked={config.botsEnabled}
                  onChange={(e) => props.onUpdateConfig({ botsEnabled: e.target.checked })}
                />
              </div>
              <div className="settings-row">
                <span>Vehicles</span>
                <input
                  type="checkbox"
                  disabled={!isHost || phase !== 'lobby'}
                  checked={config.vehiclesEnabled}
                  onChange={(e) => props.onUpdateConfig({ vehiclesEnabled: e.target.checked })}
                />
              </div>
              <div className="settings-row">
                <span>Friendly fire</span>
                <input
                  type="checkbox"
                  disabled={!isHost || phase !== 'lobby'}
                  checked={config.friendlyFire}
                  onChange={(e) => props.onUpdateConfig({ friendlyFire: e.target.checked })}
                />
              </div>
            </div>
          </div>

          <div className="col">
            <p className="section-title">Room code</p>
            <div className="roomcode">{roomCode ?? '-----'}</div>
            <p className="hint">
              Share this code so friends can join with "Join by Code". Open a
              second browser tab to test with two clients.
            </p>
            <button
              className="btn"
              onClick={() => { if (roomCode) void navigator.clipboard?.writeText(roomCode); }}
            >
              Copy code
            </button>

            <div className="divider" />
            <p className="hint">{humans.length} human player{humans.length === 1 ? '' : 's'} connected</p>

            {isHost ? (
              <button
                className="btn primary big wide"
                disabled={phase !== 'lobby'}
                onClick={props.onStart}
              >
                {phase === 'lobby' ? 'Start Match' : 'Starting...'}
              </button>
            ) : (
              <button
                className={`btn big wide${me?.ready ? ' primary' : ''}`}
                onClick={() => props.onReady(!me?.ready)}
              >
                {me?.ready ? 'Ready' : 'Mark Ready'}
              </button>
            )}
            <p className="hint">
              Empty slots are filled with bots when the match starts, so you can
              start with a single player.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
