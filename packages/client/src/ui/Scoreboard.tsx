import { Fragment } from 'react';
import { TEAM_PRESETS, type ScoreEntry } from '@gridlock/shared';
import { useStore } from '../store.js';
import { teamColorFor } from '../render/assets.js';

interface Props {
  entries: ScoreEntry[];
  teamScores: number[];
  /** Rendered inside the results screen without the overlay chrome. */
  inline?: boolean;
}

export function Scoreboard({ entries, teamScores, inline }: Props): React.ReactElement {
  const { playerId, settings, config } = useStore();

  const teams = Array.from({ length: Math.max(1, config.teamCount) }, (_, t) => t);

  const body = (
    <div className="board">
      <table>
        <thead>
          <tr>
            <th style={{ width: '40%' }}>Player</th>
            <th className="num">Score</th>
            <th className="num">K</th>
            <th className="num">D</th>
            <th className="num">A</th>
            <th className="num">Best streak</th>
            <th className="num">Damage</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((team) => {
            const roster = entries.filter((e) => e.team === team);
            if (roster.length === 0) return null;
            const color = teamColorFor(team, settings.colorblind);
            return (
              <Fragment key={team}>
                <tr
                  className="team-head"
                  key={`h${team}`}
                  style={{ '--team': color } as React.CSSProperties}
                >
                  <td style={{ color }}>
                    {TEAM_PRESETS[team]?.symbol} {TEAM_PRESETS[team]?.name}
                  </td>
                  <td className="num" style={{ color }}>{teamScores[team] ?? 0}</td>
                  <td colSpan={5} />
                </tr>
                {roster.map((e) => (
                  <tr key={e.playerId} className={e.playerId === playerId ? 'you' : ''}>
                    <td>
                      {e.name}
                      {e.isBot && <span className="tag bot" style={{ marginLeft: 6 }}>BOT</span>}
                      {e.connection === 'reconnecting' && (
                        <span className="tag away" style={{ marginLeft: 6 }}>AWAY</span>
                      )}
                    </td>
                    <td className="num">{Math.round(e.stats.score)}</td>
                    <td className="num">{e.stats.kills}</td>
                    <td className="num">{e.stats.deaths}</td>
                    <td className="num">{e.stats.assists}</td>
                    <td className="num">{e.stats.bestStreak}</td>
                    <td className="num">{Math.round(e.stats.damageDealt)}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (inline) return body;
  return <div className="overlay">{body}</div>;
}
