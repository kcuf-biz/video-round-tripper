import type { MoshConfig } from '@video-round-tripper/roundtrip'

export interface Knobs {
  disabled: boolean
  coarseness: number
  encodeScale: number
  captureFps: number
  declaredFramerate: number
  gopInfinite: boolean
  gop: number
  mosh: boolean
  dropKeyframesAfter: number
  dropDeltaChance: number
  codec: string
  captureMode: 'continuous' | 'on-interaction'
}

export const DEFAULTS: Knobs = {
  disabled: false,
  coarseness: 0.78,
  encodeScale: 1,
  captureFps: 30,
  declaredFramerate: 60,
  gopInfinite: true,
  gop: 30,
  mosh: false,
  dropKeyframesAfter: 0,
  dropDeltaChance: 0,
  codec: 'auto',
  captureMode: 'continuous',
}

export function moshFrom(k: Knobs): MoshConfig | false {
  if (!k.mosh) return false
  return {
    dropKeyframesAfter: k.dropKeyframesAfter,
    dropDeltaChance: k.dropDeltaChance,
    seed: 1,
  }
}


/**
 * Measured starting points. Dropping a keyframe is what produces the bloom, so the GOP sets
 * how often that can happen: there is nothing to drop between keyframes. dropDeltaChance
 * tears without needing keyframes at all, which is the only thing that does anything when
 * keyframes are switched off entirely.
 */
export const PRESETS: { name: string; hint: string; knobs: Partial<Knobs> }[] = [
  {
    name: 'clean',
    hint: 'no moshing, just compression',
    knobs: { mosh: false, gopInfinite: true, coarseness: 0.78 },
  },
  {
    name: 'occasional bloom',
    hint: 'mostly coherent, collapses now and then — the classic datamosh',
    knobs: { mosh: true, gopInfinite: false, gop: 20, dropKeyframesAfter: 0, dropDeltaChance: 0, coarseness: 0.8 },
  },
  {
    name: 'constant churn',
    hint: 'never settles; busier and choppier',
    knobs: { mosh: true, gopInfinite: false, gop: 8, dropKeyframesAfter: 0, dropDeltaChance: 0, coarseness: 0.82 },
  },
  {
    name: 'tearing only',
    hint: 'continuous decay, no keyframes involved',
    knobs: { mosh: true, gopInfinite: true, dropKeyframesAfter: 0, dropDeltaChance: 0.08, coarseness: 0.8 },
  },
]

export function Controls({ k, set }: { k: Knobs; set: (n: Partial<Knobs>) => void }) {
  return (
    <aside className="panel">
      <h2>Presets</h2>
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" title={p.hint} onClick={() => set(p.knobs)}>
            {p.name}
          </button>
        ))}
      </div>

      <h2 style={{ marginTop: 18 }}>Encoder</h2>

      <div className="row">
        <label className="check">
          <input type="checkbox" checked={!k.disabled} onChange={(e) => set({ disabled: !e.target.checked })} />
          round-tripping on
        </label>
      </div>

      <div className="row">
        <label>
          coarseness <b>{k.coarseness.toFixed(2)}</b>
        </label>
        <input
          type="range" min={0} max={1} step={0.01} value={k.coarseness}
          onChange={(e) => set({ coarseness: +e.target.value })}
        />
      </div>

      <div className="row">
        <label>
          encode scale <b>{k.encodeScale.toFixed(2)}x</b>
        </label>
        <input
          type="range" min={0.1} max={1} step={0.05} value={k.encodeScale}
          onChange={(e) => set({ encodeScale: +e.target.value })}
        />
      </div>

      <div className="row">
        <label>
          capture fps <b>{k.captureFps}</b>
        </label>
        <input
          type="range" min={1} max={60} step={1} value={k.captureFps}
          onChange={(e) => set({ captureFps: +e.target.value })}
        />
      </div>

      <div className="row">
        <label>
          declared framerate (the lie) <b>{k.declaredFramerate}</b>
        </label>
        <input
          type="range" min={1} max={120} step={1} value={k.declaredFramerate}
          onChange={(e) => set({ declaredFramerate: +e.target.value })}
        />
      </div>

      <div className="row">
        <label>capture mode</label>
        <select
          value={k.captureMode}
          onChange={(e) => set({ captureMode: e.target.value as Knobs['captureMode'] })}
        >
          <option value="continuous">continuous</option>
          <option value="on-interaction">on interaction only</option>
        </select>
      </div>

      <div className="row">
        <label>codec</label>
        {/*
          FAMILIES, not codec strings. The concrete string carries a level and the level has to
          be derived from the coded size — picking "avc1.42001f" by hand is how AVC silently
          vanished from the probe on anything bigger than 921,600px.
        */}
        <select value={k.codec} onChange={(e) => set({ codec: e.target.value })}>
          <option value="auto">auto (probe: AVC first)</option>
          <option value="avc">H.264 / AVC</option>
          <option value="hevc">HEVC</option>
          <option value="av1">AV1</option>
          <option value="vp9">VP9</option>
        </select>
      </div>

      <h2 style={{ marginTop: 18 }}>Keyframes</h2>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={k.gopInfinite} onChange={(e) => set({ gopInfinite: e.target.checked })} />
          never send another keyframe
        </label>
      </div>
      {!k.gopInfinite && (
        <div className="row">
          <label>
            GOP <b>{k.gop}</b>
          </label>
          <input
            type="range" min={1} max={300} step={1} value={k.gop}
            onChange={(e) => set({ gop: +e.target.value })}
          />
        </div>
      )}

      <h2 style={{ marginTop: 18 }}>Mosh</h2>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={k.mosh} onChange={(e) => set({ mosh: e.target.checked })} />
          drop chunks before the decoder
        </label>
      </div>
      {k.mosh && k.gopInfinite && k.dropDeltaChance === 0 && (
        <p className="warn">
          Mosh drops keyframes, but “never send another keyframe” means there are none after
          the first to drop — so this does nothing right now. Uncheck it and set a GOP, or
          raise “drop delta chance”.
        </p>
      )}
      {k.mosh && (
        <>
          <div className="row">
            <label>
              drop keyframes after frame <b>{k.dropKeyframesAfter}</b>
            </label>
            <input
              type="range" min={0} max={120} step={1} value={k.dropKeyframesAfter}
              onChange={(e) => set({ dropKeyframesAfter: +e.target.value })}
            />
          </div>
          <div className="row">
            <label>
              drop delta chance <b>{k.dropDeltaChance.toFixed(2)}</b>
            </label>
            <input
              type="range" min={0} max={0.5} step={0.01} value={k.dropDeltaChance}
              onChange={(e) => set({ dropDeltaChance: +e.target.value })}
            />
          </div>
        </>
      )}

      <p className="note">
        coarseness is normalized 0–1 and mapped per codec, because at the same raw QP AV1
        artifacts far less than H.264. The mapping is calibrated by eye — if a codec switch
        changes the look at a fixed coarseness, the table in quantizer.ts is what to fix.
      </p>
    </aside>
  )
}
