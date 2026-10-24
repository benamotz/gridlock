import { useEffect, useRef, useState } from 'react';
import type { CashReason } from '@gridlock/shared';

const ROLL_MS = 650;
/** At or above this a gain gets the gold treatment. */
const BIG = 300;

const REASON: Record<string, string> = {
  pickup: 'Picked up', wallet: 'Wallet', bounty: 'Bounty', chop: 'Chop shop',
  respray: 'Respray', bail: 'Bail', robbery: 'Robbery', purchase: 'Purchase',
  job: 'Job pay', death: 'Dropped',
};

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

interface Props {
  cash: number;
  last: { amount: number; reason: CashReason; at: number } | null;
}

/**
 * The free-roam cash readout. The figure rolls to its new value instead of
 * jumping, bounces green on a gain (gold, with a burst, on a big one) and
 * shakes red on a loss; each change also floats a "+$X Reason" chip off it.
 */
export function CashCounter({ cash, last }: Props): React.ReactElement {
  const [shown, setShown] = useState(cash);
  const from = useRef(cash);
  const shownRef = useRef(cash);

  useEffect(() => {
    from.current = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / ROLL_MS);
      // Ease out: fast at first, settling onto the figure.
      const eased = 1 - (1 - t) ** 3;
      const value = from.current + (cash - from.current) * eased;
      shownRef.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Animation frames stop in background tabs (and some embedded views); the
    // figure must still end up right, so land on it once the roll is overdue.
    const settle = window.setTimeout(() => {
      shownRef.current = cash;
      setShown(cash);
    }, ROLL_MS + 80);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [cash]);

  const fresh = last !== null && performance.now() - last.at < 1800;
  const mood = !fresh || !last
    ? ''
    : last.amount < 0 ? 'loss' : last.amount >= BIG ? 'big' : 'gain';

  return (
    <div className={`hud-cash ${mood}`} key={fresh && last ? last.at : 'idle'}>
      <span className="hud-cash-figure">{money(shown)}</span>
      {fresh && last && (
        <span className={`hud-cash-delta ${last.amount >= 0 ? 'up' : 'down'}`}>
          {last.amount >= 0 ? '+' : '-'}{money(Math.abs(last.amount))} {REASON[last.reason] ?? ''}
        </span>
      )}
      {mood === 'big' && (
        <span className="hud-cash-burst" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ '--a': `${i * 45}deg` } as React.CSSProperties}>$</i>
          ))}
        </span>
      )}
    </div>
  );
}
