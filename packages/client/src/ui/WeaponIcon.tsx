import type { WeaponId } from '@gridlock/shared';
import { WEAPON_ICONS } from '../render/weaponIcons.js';

interface Props {
  weapon: WeaponId;
  size?: number;
  /** Main silhouette colour. */
  color?: string;
  /** Colour for sights, muzzles and other detail shapes. */
  accent?: string;
  title?: string;
}

/**
 * Renders a weapon silhouette from the shared icon paths.
 *
 * The canvas renderer draws these exact paths for world pickups, so a weapon
 * lying in the street and the same weapon in your loadout always look alike.
 */
export function WeaponIcon({
  weapon, size = 16, color = 'currentColor', accent, title,
}: Props): React.ReactElement {
  const icon = WEAPON_ICONS[weapon];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: 'block', flex: 'none' }}
    >
      {title && <title>{title}</title>}
      {icon.paths.map((d, i) => (
        <path key={`p${i}`} d={d} fill={color} />
      ))}
      {(icon.accents ?? []).map((d, i) => (
        <path
          key={`a${i}`}
          d={d}
          fill={accent ?? color}
          stroke={accent ?? color}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
