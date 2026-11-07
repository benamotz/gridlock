import { useEffect, useState } from 'react';
import { deployableDef } from '@gridlock/shared';
import type { GameClient } from '../game/GameClient.js';
import type { TouchAction } from '../game/touch/TouchInput.js';
import { contextFromPrompt } from '../game/touch/gestures.js';
import { buzz } from '../game/touch/device.js';
import { useStore } from '../store.js';

interface Props {
  client(): GameClient | null;
  onToggleMap(): void;
  onToggleScoreboard(): void;
  onMenu(): void;
}

/** Sound, full screen and landscape are unlocked once per page, on a tap. */
let unlocked = false;

/**
 * Full screen, then a landscape lock where the browser allows them (Android
 * Chrome). Must run inside a user action that counts as one: on a touchscreen
 * that is the finger *lifting* (click), not touching down - requesting it on
 * pointerdown was silently refused. iPhones do not offer full screen to web
 * pages and get the rotate prompt instead.
 */
function enterFullscreen(): void {
  const root = document.documentElement as HTMLElement & {
    requestFullscreen?: (o?: object) => Promise<void>;
  };
  if (document.fullscreenElement || !root.requestFullscreen) return;
  root.requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      return orientation?.lock?.('landscape');
    })
    .catch(() => undefined);
}

const fullscreenSupported = (): boolean =>
  typeof document !== 'undefined' && document.fullscreenEnabled === true;

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * The on-screen touch buttons. The two sticks live in `TouchInput` (DOM, not
 * React, so they track a thumb without re-rendering); everything here is a
 * button that reports press and release to the client.
 */
export function TouchHud(props: Props): React.ReactElement {
  const { hud, settings, config } = useStore();
  const [ready, setReady] = useState(unlocked);
  // Back gestures and app switches leave full screen; offer a way back in.
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const onChange = (): void => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const dead = hud.life !== 'alive';
  const freeRoam = config.mode === 'freeroam';
  const context = contextFromPrompt(hud.prompt, hud.inVehicle);

  const hold = (action: TouchAction) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // The press still counts if capture is refused.
      }
      e.currentTarget.classList.add('pressed');
      props.client()?.touchPress(action, true);
      if (settings.haptics) buzz(8);
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.classList.remove('pressed');
      props.client()?.touchPress(action, false);
    },
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.classList.remove('pressed');
      props.client()?.touchPress(action, false);
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  const tap = (fn: () => void) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      fn();
      if (settings.haptics) buzz(8);
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  const start = (): void => {
    unlocked = true;
    setReady(true);
    props.client()?.unlockAudio();
    enterFullscreen();
  };

  const slots = hud.slots.filter((s) => s.weapon !== null);
  const placing = hud.placing;
  // Defences show only where they can be used (inside your own base), like
  // the desktop panel, so the field stays uncluttered.
  const showDefences = !freeRoam && !hud.inVehicle &&
    (placing !== null || hud.deployables.some((d) => d.canDeploy || d.cooldownMs > 0));

  return (
    <div className="touch-hud">
      <div className="touch-rotate">
        <div className="touch-rotate-icon">⟳</div>
        Turn your phone sideways to play
      </div>

      {!ready && (
        <button className="touch-start" onClick={start} onContextMenu={(e) => e.preventDefault()}>
          <span className="big">Tap to play</span>
          <span className="sub">Left thumb moves · right thumb shoots</span>
        </button>
      )}

      <div className="touch-top-icons">
        {ready && !fullscreen && fullscreenSupported() && (
          <button className="touch-icon" title="Full screen" onClick={enterFullscreen}>⛶</button>
        )}
        <button className="touch-icon" {...tap(props.onToggleMap)}>Map</button>
        <button className="touch-icon" {...tap(props.onToggleScoreboard)}>
          {freeRoam ? 'Top $' : 'Scores'}
        </button>
        <button className="touch-icon" {...tap(props.onMenu)}>☰</button>
      </div>

      {!dead && (
        <>
          <div className="touch-slots">
            {slots.map((s) => (
              <button
                key={s.index}
                className={`touch-slot${s.active ? ' active' : ''}`}
                {...tap(() => props.client()?.touchSlot(s.index))}
              >
                {s.name}
              </button>
            ))}
          </div>

          <div className="touch-pouch">
            <button className={`touch-btn small${hud.medkits > 0 ? '' : ' empty'}`} {...hold('useMedkit')}>
              +HP<i>{hud.medkits}</i>
            </button>
            <button className={`touch-btn small${hud.armorPlates > 0 ? '' : ' empty'}`} {...hold('useArmor')}>
              ARM<i>{hud.armorPlates}</i>
            </button>
          </div>

          {showDefences && (
            <div className="touch-defences">
              {hud.deployables.map((d) => {
                const selected = placing?.kind === d.kind;
                const ready = d.canDeploy;
                return (
                  <button
                    key={d.kind}
                    className={`touch-defence${ready ? ' ready' : ''}${selected ? ' selected' : ''}`}
                    {...tap(() => props.client()?.touchDeploy(d.kind))}
                  >
                    {deployableDef(d.kind).name}
                    <i>{d.cooldownMs > 0 ? `${Math.ceil(d.cooldownMs / 1000)}s` : `${d.remaining}`}</i>
                  </button>
                );
              })}
            </div>
          )}

          {placing ? (
            <div className="touch-actions">
              <div className="touch-placing-hint">Drag the right stick to aim</div>
              <button
                className={`touch-btn place${placing.valid ? '' : ' invalid'}`}
                {...tap(() => props.client()?.touchPlace())}
              >
                Place
              </button>
              {deployableDef(placing.kind).rotatable && (
                <button className="touch-btn rotate" {...tap(() => props.client()?.touchRotate())}>
                  Turn
                </button>
              )}
              <button className="touch-btn cancel" {...tap(() => props.client()?.touchCancelPlacement())}>
                ✕
              </button>
            </div>
          ) : (
          <div className="touch-actions">
            {context && (
              <button className="touch-btn context" {...hold(context.action)}>
                {context.label}
              </button>
            )}
            {!hud.inVehicle && <button className="touch-btn jump" {...hold('jump')}>Jump</button>}
            {!hud.inVehicle && <button className="touch-btn reload" {...hold('reload')}>Reload</button>}
            {settings.touchFire === 'button' && (
              <button className="touch-btn fire" {...hold('fire')}>Fire</button>
            )}
          </div>
          )}
        </>
      )}

      {freeRoam && hud.phoneOffer && !dead && (
        <div className={`touch-phone kind-${hud.phoneOffer.kind}`}>
          <div className="touch-phone-head">
            ☎ {settings.storyText && hud.phoneOffer.contact ? hud.phoneOffer.contact : 'Incoming job'}
            {' '}· {Math.ceil(hud.phoneLeftMs / 1000)}s
          </div>
          <div className="touch-phone-text">{hud.phoneOffer.text} - {money(hud.phoneOffer.reward)}</div>
          <div className="touch-phone-buttons">
            <button className="take" {...tap(() => props.client()?.answerPhone(true))}>Take</button>
            <button className="pass" {...tap(() => props.client()?.answerPhone(false))}>Pass</button>
          </div>
        </div>
      )}
    </div>
  );
}
