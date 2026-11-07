import { useStore } from '../store.js';

interface Props {
  onClose(): void;
  onLeaveMatch?(): void;
}

/** Pause / settings panel, opened with Esc during a match. */
export function SettingsPanel({ onClose, onLeaveMatch }: Props): React.ReactElement {
  const { settings, updateSettings } = useStore();

  const slider = (
    label: string,
    key: 'masterVolume' | 'musicVolume' | 'effectsVolume' | 'sensitivity' | 'aimAssist' | 'touchAimAssist',
    max = 1,
  ): React.ReactElement => (
    <div className="settings-row" key={key}>
      <span>{label}</span>
      <div className="row">
        <input
          type="range"
          min={0}
          max={max}
          step={0.05}
          value={settings[key]}
          onChange={(e) => updateSettings({ [key]: Number(e.target.value) })}
        />
        <span className="hint" style={{ width: 34, textAlign: 'right' }}>
          {key === 'sensitivity' ? settings[key].toFixed(2) : Math.round(settings[key] * 100)}
        </span>
      </div>
    </div>
  );

  const toggle = (
    label: string,
    key: 'screenShake' | 'colorblind' | 'reduceFlashing' | 'showLatency' | 'storyText' | 'leftHanded' | 'haptics' | 'showPerf',
    hint?: string,
  ): React.ReactElement => (
    <div className="settings-row" key={key}>
      <span>
        {label}
        {hint && <div className="hint">{hint}</div>}
      </span>
      <input
        type="checkbox"
        checked={settings[key]}
        onChange={(e) => updateSettings({ [key]: e.target.checked })}
      />
    </div>
  );

  const choice = <K extends 'touchControls' | 'touchFire' | 'touchDrive' | 'touchButtonSize'>(
    label: string,
    key: K,
    options: [string, string][],
    hint?: string,
  ): React.ReactElement => (
    <div className="settings-row" key={key}>
      <span>
        {label}
        {hint && <div className="hint">{hint}</div>}
      </span>
      <select
        value={settings[key]}
        onChange={(e) => updateSettings({ [key]: e.target.value } as Partial<typeof settings>)}
      >
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </div>
  );

  return (
    <div className="overlay">
      <div className="card" style={{ width: 'min(620px, 100%)' }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <h2 className="grow" style={{ margin: 0, letterSpacing: '0.08em' }}>SETTINGS</h2>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <p className="section-title">Audio</p>
        <div className="settings-list">
          {slider('Master volume', 'masterVolume')}
          {slider('Effects volume', 'effectsVolume')}
          {slider('Music volume', 'musicVolume')}
        </div>

        <div className="divider" />
        <p className="section-title">Controls</p>
        <div className="settings-list">
          {slider('Mouse sensitivity', 'sensitivity', 2)}
          {slider('Aim assist', 'aimAssist')}
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          Aim assist gently pulls your crosshair toward a nearby enemy in your
          line of sight. Set it to 0 to aim entirely by hand.
        </p>
        <p className="hint" style={{ marginTop: 8 }}>
          Key rebinding is wired through the input layer's binding table and is
          exposed in a later milestone; the defaults are listed on the main menu.
        </p>

        <div className="divider" />
        <p className="section-title">Touch</p>
        <div className="settings-list">
          {choice('Touch controls', 'touchControls', [
            ['auto', 'Auto'], ['on', 'On'], ['off', 'Off'],
          ], 'Auto shows them on phones and tablets only.')}
          {choice('Right thumb', 'touchFire', [
            ['stick', 'Fire stick'], ['button', 'Fire button'],
          ], 'Fire stick: tap to shoot the marked target, hold to keep firing, drag to aim.')}
          {choice('Driving', 'touchDrive', [
            ['screen', 'Point where to go'], ['car', 'Steer like a car'],
          ])}
          {choice('Button size', 'touchButtonSize', [
            ['S', 'Small'], ['M', 'Medium'], ['L', 'Large'],
          ])}
          {slider('Touch aim assist', 'touchAimAssist')}
          {toggle('Left-handed layout', 'leftHanded', 'Move with the right thumb, shoot with the left.')}
          {toggle('Vibration', 'haptics', 'Short buzzes on hits and button presses (Android).')}
        </div>

        <div className="divider" />
        <p className="section-title">Accessibility</p>
        <div className="settings-list">
          {toggle('Screen shake', 'screenShake', 'Camera kick on explosions and impacts')}
          {toggle('Reduce flashing', 'reduceFlashing', 'Removes the damage screen flash')}
          {toggle(
            'Colourblind-friendly teams',
            'colorblind',
            'Switches to an accessible palette. Team symbols are always shown.',
          )}
          {toggle('Show network latency', 'showLatency')}
          {toggle(
            'Story text',
            'storyText',
            'Lines from job contacts in the city. Off shows just the job itself.',
          )}
        </div>

        <div className="divider" />
        <p className="section-title">Performance</p>
        <div className="settings-list">
          <div className="settings-row">
            <span>Quality preset</span>
            <select
              value={settings.quality}
              onChange={(e) => updateSettings({
                quality: e.target.value as typeof settings.quality,
              })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          {toggle('Show performance', 'showPerf', 'Frame rate and timing in a corner, for checking how a device copes.')}
          <div className="settings-row">
            <span>Fullscreen</span>
            <button
              className="btn"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void document.documentElement.requestFullscreen();
              }}
            >
              Toggle
            </button>
          </div>
        </div>

        {onLeaveMatch && (
          <>
            <div className="divider" />
            <button className="btn danger wide" onClick={onLeaveMatch}>
              Leave match
            </button>
          </>
        )}
      </div>
    </div>
  );
}
