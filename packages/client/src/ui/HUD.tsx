import { useEffect, useRef, useState } from 'react';
import { TEAM_PRESETS, deployableDef } from '@gridlock/shared';
import { useStore } from '../store.js';
import { teamColorFor } from '../render/assets.js';
import { WeaponIcon } from './WeaponIcon.js';
import { VehicleCard } from './VehicleCard.js';

/** Keys shown on the defence chips; these mirror the default bindings. */
const DEFENCE_KEYS: Record<string, string> = { barricade: 'Q', turret: 'T', mine: 'X' };

/** How long the collection toast stays up. */
const TOAST_MS = 1400;

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

interface Props {
  mapExpanded: boolean;
  connectionWarning: string | null;
}

/**
 * In-match HUD.
 *
 * Everything here is read at a glance under pressure, so the layout keeps the
 * three things that matter most - vitals, ammunition and the score clock - in
 * fixed screen corners and never moves them.
 */
export function HUD({ mapExpanded, connectionWarning }: Props): React.ReactElement {
  const { hud, settings, killFeed } = useStore();
  const [damageFlash, setDamageFlash] = useState(false);
  const lastHp = useRef(hud.hp);

  useEffect(() => {
    if (hud.hp < lastHp.current && !settings.reduceFlashing) {
      setDamageFlash(true);
      const t = window.setTimeout(() => setDamageFlash(false), 140);
      lastHp.current = hud.hp;
      return () => window.clearTimeout(t);
    }
    lastHp.current = hud.hp;
    return undefined;
  }, [hud.hp, settings.reduceFlashing]);

  const dead = hud.life !== 'alive';
  // The HUD re-renders at snapshot rate, which is plenty for a fading toast.
  const collectAge = hud.lastCollect ? performance.now() - hud.lastCollect.at : Infinity;
  const showToast = hud.lastCollect !== null && collectAge < TOAST_MS;

  return (
    <div className="hud">
      <div className={`damage-vignette${damageFlash ? ' on' : ''}`} />

      <div className="hud-topbar">
        {hud.teamScores.map((score, team) => (
          <span
            key={team}
            className="hud-score"
            style={{ color: teamColorFor(team, settings.colorblind) }}
            title={TEAM_PRESETS[team]?.name}
          >
            {TEAM_PRESETS[team]?.symbol} {score}
          </span>
        ))}
        <span className="hud-clock">{clock(hud.timeLeftMs)}</span>
      </div>
      <div className="hud-objective">{hud.objective}</div>

      <div className="hud-team-banner">
        <span
          className="hud-team-chip"
          style={{ background: teamColorFor(hud.team, settings.colorblind) }}
        >
          {TEAM_PRESETS[hud.team]?.symbol ?? '?'}
        </span>
        <span>
          You are <b style={{ color: teamColorFor(hud.team, settings.colorblind) }}>
            {TEAM_PRESETS[hud.team]?.name ?? 'unaffiliated'}
          </b>
        </span>
        <span className="hud-team-legend">
          <i className="swatch ally" /> ally
          <i className="swatch enemy" /> enemy
        </span>
      </div>

      <div className="hud-status">
        {settings.showLatency && (
          <span className={`pill${hud.rtt > 180 ? ' warn' : ''}`}>{hud.rtt} ms</span>
        )}
        {connectionWarning && <span className="pill warn">{connectionWarning}</span>}
        {hud.protectedUntilMs > 0 && !dead && (
          <span className="pill good">
            Spawn shield {Math.ceil(hud.protectedUntilMs / 1000)}s
          </span>
        )}
        {hud.inVehicle && (
          <span className="pill">
            {hud.vehicleName} {Math.round(hud.vehicleHp * 100)}% ·{' '}
            {hud.seat === 0 ? 'driving' : `seat ${hud.seat}`} ·{' '}
            {hud.vehicleOccupants}/{hud.vehicleSeats} aboard · <b>E</b> to exit
          </span>
        )}
        {hud.inVehicle && hud.seat === 0 && (
          <span className="pill warn">Driving - passengers can shoot</span>
        )}
        {hud.inVehicle && hud.seat > 0 && (
          <span className="pill good">Riding - you can fire out</span>
        )}
      </div>

      <div className="hud-bottomleft">
        <div className="hud-vitals-labels">
          <span>HP {Math.max(0, Math.round(hud.hp))}</span>
          <span>{hud.armor > 0 ? `ARMOR ${Math.round(hud.armor)}` : ''}</span>
        </div>
        <div className="hud-bar">
          <div className="fill-hp" style={{ width: `${Math.max(0, hud.hp)}%` }} />
        </div>
        {hud.armor > 0 && (
          <div className="hud-bar">
            <div className="fill-armor" style={{ width: `${hud.armor}%` }} />
          </div>
        )}
        <div className="hud-bar" style={{ height: 7 }}>
          <div className="fill-stam" style={{ width: `${hud.stamina}%` }} />
        </div>
        <div className={`hud-jump${hud.jumpCooldownFrac > 0 ? ' cooling' : ''}`}>
          <span className="kbd-mini">SPACE</span> jump
          <i style={{ width: `${Math.round((1 - hud.jumpCooldownFrac) * 100)}%` }} />
        </div>
      </div>

      {/* The pouch: carried health and armour, used when you choose to. */}
      <div className="hud-pouch">
        <div
          className={`pouch-chip health${hud.medkits > 0 ? '' : ' empty'}`}
          title="Use a medkit"
        >
          <span className="key">H</span>
          <span className="pouch-icon">✚</span>
          <span className="pouch-count">{hud.medkits}</span>
        </div>
        <div
          className={`pouch-chip armor${hud.armorPlates > 0 ? '' : ' empty'}`}
          title="Use an armour plate"
        >
          <span className="key">G</span>
          <span className="pouch-icon">⛨</span>
          <span className="pouch-count">{hud.armorPlates}</span>
        </div>
        {hud.pouchCooldownMs > 0 && <span className="pouch-busy">…</span>}
      </div>

      <div className="hud-bottomright">
        <div className="hud-weapon">
          {hud.weaponId && (
            <WeaponIcon
              weapon={hud.weaponId}
              size={22}
              color="var(--text)"
              accent="var(--accent)"
              title={hud.weaponName}
            />
          )}
          <span>{hud.weaponName.toUpperCase()}</span>
        </div>
        <div className="hud-ammo">
          {hud.ammo < 0 ? '∞' : hud.ammo}
          {hud.ammo >= 0 && <span className="reserve"> / {hud.reserve}</span>}
        </div>
        {hud.reloading && <div className="hud-reloading">RELOADING</div>}
        <div className="hud-slots">
          {hud.slots.map((s) => (
            <div
              key={s.index}
              className={`hud-slot${s.active ? ' active' : ''}${s.name ? '' : ' empty'}${
                showToast && hud.lastCollect?.weapon && hud.lastCollect.weapon === s.weapon
                  ? ' fresh' : ''}`}
            >
              <span className="key">{s.index + 1}</span>
              {s.weapon ? (
                <WeaponIcon
                  weapon={s.weapon}
                  size={15}
                  color={s.active ? 'var(--text)' : 'var(--muted)'}
                  accent={s.active ? 'var(--accent)' : 'var(--muted)'}
                />
              ) : (
                <span className="slot-empty-dash">--</span>
              )}
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={`killfeed${mapExpanded ? ' expanded-shift' : ''}`}>
        {killFeed.map((k, i) => (
          <div className="kill-line" key={`${k.at}-${i}`}>
            <span style={{ color: teamColorFor(k.killerTeam, settings.colorblind) }}>
              {k.killer}
            </span>
            <span className="arrow">/</span>
            <span style={{ color: teamColorFor(k.victimTeam, settings.colorblind) }}>
              {k.victim}
            </span>
          </div>
        ))}
      </div>

      {/* Base defences. Shown only where they can actually be used, so the
          HUD stays quiet in the field. */}
      {!dead && (hud.placing || hud.deployables.some((d) => d.canDeploy || d.cooldownMs > 0)) && (
        <div className="hud-defences">
          <span className="defences-title">BASE DEFENCES</span>
          {hud.deployables.map((d) => {
            const def = deployableDef(d.kind);
            const key = DEFENCE_KEYS[d.kind] ?? '?';
            const selected = hud.placing?.kind === d.kind;
            return (
              <div
                key={d.kind}
                className={`defence-chip${d.canDeploy ? ' ready' : ''}${selected ? ' selected' : ''}`}
                title={def.description}
              >
                <span className="key">{key}</span>
                <span className="defence-name">{def.name}</span>
                {d.cooldownMs > 0 ? (
                  <span className="defence-state">{Math.ceil(d.cooldownMs / 1000)}s</span>
                ) : (
                  <span className="defence-state">{d.remaining} left</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hud.placing && !dead && (
        <div className={`hud-placing${hud.placing.valid ? '' : ' invalid'}`}>
          <div className="placing-title">
            PLACING {deployableDef(hud.placing.kind).name.toUpperCase()}
          </div>
          <div className="placing-help">
            {deployableDef(hud.placing.kind).rotatable && <span><b>Wheel</b> rotate</span>}
            <span><b>Click</b> or <b>{DEFENCE_KEYS[hud.placing.kind]}</b> place</span>
            <span><b>Right-click</b> / <b>Esc</b> cancel</span>
          </div>
          {!hud.placing.valid && hud.placing.reason && (
            <div className="placing-reason">{hud.placing.reason}</div>
          )}
        </div>
      )}

      {showToast && hud.lastCollect && !dead && (
        <div className={`hud-collect-toast kind-${hud.lastCollect.kind}`} key={hud.lastCollect.at}>
          {hud.lastCollect.weapon && hud.lastCollect.kind === 'weapon' && (
            <WeaponIcon weapon={hud.lastCollect.weapon} size={22} color="#10131a" accent="#3a2a08" />
          )}
          <span>
            {hud.lastCollect.stored
              ? `${hud.lastCollect.label} stored`
              : `+ ${hud.lastCollect.label}`}
          </span>
        </div>
      )}

      {hud.nearbyVehicle && !dead && !hud.placing && (
        <VehicleCard type={hud.nearbyVehicle} aboard={hud.inVehicle} />
      )}

      {hud.prompt && !dead && !hud.placing && <div className="hud-prompt">{hud.prompt}</div>}

      {dead && (
        <div className="hud-center-message">
          <div className="big" style={{ color: 'var(--danger)' }}>ELIMINATED</div>
          <div className="sub">
            {hud.respawnInMs > 0
              ? `Respawning in ${Math.ceil(hud.respawnInMs / 1000)}s`
              : 'Respawning...'}
          </div>
        </div>
      )}

      {hud.phase === 'countdown' && (
        <div className="hud-center-message">
          <div className="big" style={{ color: 'var(--accent)' }}>GET READY</div>
          <div className="sub">{hud.objective}</div>
        </div>
      )}
    </div>
  );
}
