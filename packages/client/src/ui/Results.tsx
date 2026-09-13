import { TEAM_PRESETS, type MatchEndMsg } from '@gridlock/shared';
import { useStore } from '../store.js';
import { Scoreboard } from './Scoreboard.js';
import { teamColorFor } from '../render/assets.js';

interface Props {
  results: MatchEndMsg;
  onRematch(): void;
  onLobby(): void;
  onMenu(): void;
}

const REASONS: Record<MatchEndMsg['reason'], string> = {
  score: 'Score target reached',
  time: 'Time expired',
  lastStanding: 'Last team standing',
  aborted: 'Match ended early',
};

export function Results({ results, onRematch, onLobby, onMenu }: Props): React.ReactElement {
  const { playerId, hostId, settings } = useStore();
  const isHost = playerId !== null && playerId === hostId;

  const me = results.entries.find((e) => e.playerId === playerId);
  const placement = me
    ? results.entries.findIndex((e) => e.playerId === playerId) + 1
    : null;
  const won = me && results.winningTeam !== null && me.team === results.winningTeam;

  const headline = results.winningTeam === null
    ? 'DRAW'
    : won === undefined
      ? `${TEAM_PRESETS[results.winningTeam]?.name} WINS`
      : won ? 'VICTORY' : 'DEFEAT';

  const headlineColor = results.winningTeam === null
    ? 'var(--muted)'
    : won === false ? 'var(--danger)' : 'var(--good)';

  return (
    <div className="centered">
      <div className="card">
        <div className="result-banner">
          <div className="headline" style={{ color: headlineColor }}>{headline}</div>
          <div className="why">
            {results.winningTeam !== null && (
              <span style={{ color: teamColorFor(results.winningTeam, settings.colorblind) }}>
                {TEAM_PRESETS[results.winningTeam]?.name}
                {' · '}
              </span>
            )}
            {REASONS[results.reason]}
            {placement !== null && ` · You placed #${placement} of ${results.entries.length}`}
          </div>
        </div>

        <Scoreboard entries={results.entries} teamScores={results.teamScores} inline />

        <div className="row" style={{ marginTop: 20 }}>
          {isHost && (
            <button className="btn primary" onClick={onRematch}>Rematch</button>
          )}
          <button className="btn" onClick={onLobby}>Return to Lobby</button>
          <span className="spacer" />
          <button className="btn ghost" onClick={onMenu}>Main Menu</button>
        </div>
        {!isHost && (
          <p className="hint" style={{ marginTop: 10 }}>
            The host can start a rematch. You will return to the lobby
            automatically in a few seconds.
          </p>
        )}
      </div>
    </div>
  );
}
