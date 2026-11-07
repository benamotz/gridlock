import { useState } from 'react';
import { GAMEPLAY } from '@gridlock/shared';
import { useStore } from '../store.js';

interface Props {
  onCreate(): void;
  onLeave(): void;
  onClose(): void;
}

const MAX = GAMEPLAY.freeRoam.playerCrew.maxSize;

/** The link a friend opens to join this crew (straight into the city, beside you). */
export function crewLink(code: string): string {
  return `${location.origin}/?crew=${code}`;
}

/**
 * The free-roam crew: start one, invite friends with a link (the phone's share
 * sheet where there is one, otherwise the clipboard), see who is in, leave.
 */
export function CrewPanel(props: Props): React.ReactElement {
  const crew = useStore((s) => s.hud.crew);
  const playerId = useStore((s) => s.playerId);
  const [copied, setCopied] = useState(false);

  const invite = async (): Promise<void> => {
    if (!crew) return;
    const url = crewLink(crew.code);
    const text = 'Join my crew in GRIDLOCK';
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'GRIDLOCK crew', text, url });
        return;
      }
    } catch {
      // Dismissing the share sheet lands here; fall back to copying.
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link and send it to a friend:', url);
    }
  };

  return (
    <div className="crew-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="crew-panel card">
        <div className="row">
          <h3 className="crew-title grow">Your crew</h3>
          <button className="btn ghost" onClick={props.onClose}>Close</button>
        </div>

        {!crew ? (
          <>
            <p className="hint">
              Play with up to {MAX - 1} friends: you cannot hurt each other, you share
              jobs and split the pay, and the police chase you together.
            </p>
            <button className="btn primary big wide" onClick={props.onCreate}>Start a crew</button>
          </>
        ) : (
          <>
            <ul className="crew-members">
              {crew.members.map((m) => (
                <li key={m.id} className={m.alive ? '' : 'down'}>
                  <span className="crew-dot" />
                  {m.name}{m.id === playerId ? ' (you)' : ''}
                  {!m.alive && <span className="hint"> - down</span>}
                </li>
              ))}
            </ul>
            {crew.members.length < MAX ? (
              <button className="btn primary big wide" onClick={() => void invite()}>
                {copied ? 'Link copied - send it to a friend' : 'Invite friends'}
              </button>
            ) : (
              <p className="hint">The crew is full ({MAX}).</p>
            )}
            <p className="hint crew-code">Crew code {crew.code} · friends open the link and arrive beside you</p>
            <button className="btn danger wide" onClick={props.onLeave}>Leave crew</button>
          </>
        )}
      </div>
    </div>
  );
}
