# Mobile (touch) play - v1 spec

Agreed 2026-10-27. Mobile is the primary channel; desktop must not change.

## Decisions

- **Channel:** mobile web, installable to the home screen (web app manifest,
  full screen). Store apps and Telegram can wrap this later.
- **Focus:** Free Roam first; team matches added 2026-11-07 (compact menus,
  lobby and results on short screens, touch defences, trimmed kill feed).
- **Aiming:** hybrid fire stick (below), with stronger aim assist on touch.
- **Cross-play:** phones and desktops share one city. The server already caps
  analog movement at keyboard speed and validates every shot.
- **Landscape only.** Portrait shows a "rotate your phone" prompt.

## Principle: touch is another input source

The touch layer produces the same `InputSnapshot` (buttons, aim, slot, plus
the optional analog axes) as keyboard and mouse. The server, simulation,
prediction, police, jobs and economy are untouched. Touch UI appears on touch
devices or when switched on in Settings (Auto / On / Off).

## Layout (landscape)

- **Left thumb:** floating move stick, appears where the thumb lands in the
  lower-left zone. Full push sprints. In a vehicle it steers, screen-relative.
- **Right thumb:** fire stick; a large **context button** above it whose label
  follows what is nearby (Enter / Exit / Steal / Buy SMG $400 / Take job);
  **Jump** and **Reload** beside it.
- **Top-left:** health and armour, medkit and armour-plate buttons.
- **Top-centre:** stars, cash, location, a slim job chip (tap to expand).
- **Top-right:** small minimap with Map, Scoreboard and Menu buttons.
- **Right edge:** weapon slots, tap to switch.
- **Phone calls:** compact panel with large Take / Pass buttons.
- Thumb zones (bottom corners) are never covered by HUD.

## Team matches on touch

- **Base defences:** a row of chips bottom-centre, only inside your own base.
  The first tap opens placement, a second tap on the same chip places it.
  While placing, Place / Turn / ✕ take the action buttons' spots, the right
  stick points the preview, and auto-target and aim assist are off so the
  preview never drifts toward an enemy.
- **Short screens** (height <= 520px): menus tighten, the lobby keeps two
  columns with Start / Ready pinned at the top of the right one.
- **Kill feed:** the newest three lines only.
- A press on any on-screen button never also counts as a click on the world.

## Layout revision (2026-11-07, after playtesting)

- Jump, Reload and the context button sit in one column on the right edge;
  the fire stick's resting spot is a thumb-width to their left (playtesting
  found the right thumb landing on Reload and Jump).
- Crew / Top $ / menu / full-screen are a column beside the minimap, away
  from the action buttons. There is no Map button: tap the minimap to open
  the big map, tap the big map to close it.
- Main menu: one primary choice (Enter the City), Team Match and Practice
  as secondary, Private match / Join by code as links, the name inline.
  Two columns on a sideways phone, so it never scrolls; keyboard controls
  only on desktop, folded under "Controls".

## Touch driving revision (2026-11-07, after playtesting)

"Point where you want to go" felt like the car went the opposite way: it
reversed whenever the thumb pointed behind the car, which in a city happens
after every bump and at every junction. Now, for players only (residents keep
`routeSteer`, the original mapping):

- pointing behind slows the car and swings it round *forwards*; it backs up
  only when its nose is against a wall;
- a half push is already full speed (`drivePedal`);
- a direction within ~17 degrees of a street axis snaps onto it (`snapToRoad`);
- a white chevron off the car shows the heading the stick is asking for.

## Hybrid fire stick

- **Tap:** fires at the best target ahead. **Hold:** keeps firing and tracks it.
  **Drag:** aims by hand while firing. Semi-automatic weapons are pulsed.
- A marker shows who a tap will hit.
- **Auto-target only picks threats:** gunmen set against you, police when you
  are wanted, players who recently hurt you, wanted players, your job target
  (and enemies in team modes). Never a pedestrian, bystander or unwanted
  player - those need a manual drag, so a tap can never become a murder.
- Settings can swap the stick for a separate fire button.

## Settings (touch)

Touch controls Auto/On/Off; fire stick or fire button; screen- or car-relative
driving; touch aim assist; left-handed (mirrored) layout; button size S/M/L;
vibration (Android only - iOS Safari has no vibration API).

## Phone setup

- Camera zoom follows the viewport so a phone sees a similar slice of the city.
- Phone defaults: lower pixel-ratio cap, smaller ground-chunk cache.
- Web app manifest, icons, a pass-through service worker (installability only,
  no caching), "Tap to play" overlay (unlocks audio, full screen, landscape
  lock on Android), no pinch-zoom, scroll, long-press or text selection,
  safe-area insets.

## Not in v1

Store apps, team-mode polish, gamepads, chat (Free Roam phase 2).
