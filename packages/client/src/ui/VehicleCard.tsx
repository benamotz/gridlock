import { type VehicleTypeId, vehicleDef, vehicleRatings } from '@gridlock/shared';

interface Props {
  type: VehicleTypeId;
  /** True when the player is aboard, false when just standing next to it. */
  aboard: boolean;
}

const BARS: { key: keyof ReturnType<typeof vehicleRatings>; label: string }[] = [
  { key: 'speed', label: 'Top speed' },
  { key: 'acceleration', label: 'Acceleration' },
  { key: 'handling', label: 'Handling' },
  { key: 'armour', label: 'Armour' },
  { key: 'ram', label: 'Ram power' },
];

/**
 * What a vehicle is good and bad at, shown as you approach it.
 *
 * Every number is derived from the vehicle data, so the card cannot drift out
 * of step with how the vehicle actually handles and takes damage.
 */
export function VehicleCard({ type, aboard }: Props): React.ReactElement {
  const def = vehicleDef(type);
  const ratings = vehicleRatings(def);

  return (
    <div className={`vehicle-card${aboard ? ' aboard' : ''}`}>
      <div className="vehicle-card-head">
        <span className="vehicle-category">{def.category.toUpperCase()}</span>
        <span className="vehicle-model">{def.name}</span>
      </div>
      <div className="vehicle-seats">
        {Array.from({ length: def.seats }).map((_, i) => (
          <i key={i} className="seat" />
        ))}
        <span>{def.seats} seat{def.seats === 1 ? '' : 's'}</span>
        {!def.shieldsOccupants && <span className="exposed">riders exposed</span>}
      </div>
      {BARS.map((b) => (
        <div className="vehicle-stat" key={b.key}>
          <span>{b.label}</span>
          <div className="vehicle-stat-bar">
            <div style={{ width: `${Math.round(ratings[b.key] * 100)}%` }} />
          </div>
        </div>
      ))}
      <ul className="vehicle-traits">
        {def.pros.map((t) => <li key={t} className="pro">+ {t}</li>)}
        {def.cons.map((t) => <li key={t} className="con">- {t}</li>)}
      </ul>
    </div>
  );
}
