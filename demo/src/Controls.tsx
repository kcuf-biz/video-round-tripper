import type { CodecChoice, CodecDials, MoshConfig } from '@video-round-tripper/roundtrip'

/**
 * What the stage reported through `onCodec`: the codec its probe picked and the dials it
 * resolved against that family. Not an estimate — it is read back out of the running
 * pipeline, so it is the only trustworthy answer while the panel is on auto.
 */
export interface PickedCodec {
  choice: CodecChoice
  dials: CodecDials
}

export interface Knobs {
  disabled: boolean
  /**
   * Leave coarseness / GOP / mosh UNSPECIFIED, so the picked codec family's defaults apply.
   *
   * This exists because the panel was making the per-codec default table dead code: it sent
   * an explicit value for all three on every render, and an explicit value always wins. The
   * state a bare <RoundTrip> is in — the one a consumer of this package actually gets — was
   * the one state the demo could not show.
   */
  auto: boolean
  coarseness: number
  encodeScale: number
  captureFps: number
  declaredFramerate: number
  gopInfinite: boolean
  gop: number
  mosh: boolean
  dropKeyframesAfter: number
  keepEveryNthKeyframe: number
  dropDeltaChance: number
  codec: string
  captureMode: 'continuous' | 'on-interaction'
}

export const DEFAULTS: Knobs = {
  disabled: false,
  auto: true,
  coarseness: 0.78,
  encodeScale: 1,
  captureFps: 30,
  declaredFramerate: 60,
  gopInfinite: true,
  gop: 30,
  mosh: false,
  dropKeyframesAfter: 0,
  keepEveryNthKeyframe: 0,
  dropDeltaChance: 0,
  codec: 'auto',
  captureMode: 'continuous',
}

/**
 * The knobs that have a per-codec default. Touching any of them is what takes the panel off
 * auto: the alternative is a checkbox the user has to remember to uncheck before the slider
 * they are already dragging does anything, which reads as the slider being broken.
 */
const DIAL_KEYS = [
  'coarseness',
  'gopInfinite',
  'gop',
  'mosh',
  'dropKeyframesAfter',
  'keepEveryNthKeyframe',
  'dropDeltaChance',
] as const

export function touchesDials(patch: Partial<Knobs>): boolean {
  return DIAL_KEYS.some((key) => key in patch)
}

export function moshFrom(k: Knobs): MoshConfig | false {
  if (!k.mosh) return false
  return {
    dropKeyframesAfter: k.dropKeyframesAfter,
    keepEveryNthKeyframe: k.keepEveryNthKeyframe,
    dropDeltaChance: k.dropDeltaChance,
    seed: 1,
  }
}

/**
 * The inverse of moshFrom, plus the other two dials: the knob positions that mean the same
 * thing as a set of resolved dials.
 *
 * Leaving auto has to CONTINUE from whatever auto resolved to. It used to fall back to this
 * panel's own DEFAULTS, so unchecking "never send another keyframe" on the AVC auto state
 * (coarseness 0.78 / GOP 20 / drop every keyframe) silently switched moshing OFF — and "GOP
 * 20" then looked identical to "no keyframes", because neither of them was moshing.
 */
export function knobsFromDials(prev: Knobs, d: CodecDials): Knobs {
  return {
    ...prev,
    coarseness: d.coarseness,
    gopInfinite: d.gop === 'infinite',
    // 'infinite' has no number to show, so the slider keeps whatever it was last set to.
    gop: typeof d.gop === 'number' ? d.gop : prev.gop,
    mosh: !!d.mosh,
    dropKeyframesAfter: d.mosh ? (d.mosh.dropKeyframesAfter ?? 0) : 0,
    keepEveryNthKeyframe: d.mosh ? (d.mosh.keepEveryNthKeyframe ?? 0) : 0,
    dropDeltaChance: d.mosh ? (d.mosh.dropDeltaChance ?? 0) : 0,
  }
}

/** Shared with DeviceInfo so the panel and the readout describe a mosh the same way. */
export function describeMosh(mosh: CodecDials['mosh']): string {
  if (!mosh) return 'off'
  const parts = [`drop keys after ${mosh.dropKeyframesAfter ?? 0}`]
  if (mosh.keepEveryNthKeyframe) parts.push(`keep every ${mosh.keepEveryNthKeyframe}`)
  if (mosh.dropDeltaChance) parts.push(`${Math.round(mosh.dropDeltaChance * 100)}% deltas`)
  return parts.join(' · ')
}


/**
 * Measured starting points. Dropping a keyframe is what produces the bloom, so the GOP sets
 * how often that can happen: there is nothing to drop between keyframes. dropDeltaChance
 * tears without needing keyframes at all, which is the only thing that does anything when
 * keyframes are switched off entirely.
 *
 * Each one states every mosh knob it depends on, keepEveryNthKeyframe included: a preset that
 * left one unset would inherit whatever the last preset put there and would not be the look
 * it is named after. "tearing only" sets it to 0 on purpose — there are no keyframes to keep.
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
    knobs: { mosh: true, gopInfinite: false, gop: 20, dropKeyframesAfter: 0, keepEveryNthKeyframe: 3, dropDeltaChance: 0, coarseness: 0.8 },
  },
  {
    name: 'constant churn',
    hint: 'never settles; busier and choppier',
    knobs: { mosh: true, gopInfinite: false, gop: 8, dropKeyframesAfter: 0, keepEveryNthKeyframe: 4, dropDeltaChance: 0, coarseness: 0.82 },
  },
  {
    name: 'tearing only',
    hint: 'continuous decay, no keyframes involved',
    knobs: { mosh: true, gopInfinite: true, dropKeyframesAfter: 0, keepEveryNthKeyframe: 0, dropDeltaChance: 0.08, coarseness: 0.8 },
  },
]

export function Controls({
  k,
  set,
  picked,
}: {
  k: Knobs
  set: (n: Partial<Knobs>) => void
  picked: PickedCodec | null
}) {
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
        <label className="check">
          <input type="checkbox" checked={k.auto} onChange={(e) => set({ auto: e.target.checked })} />
          auto — per-codec defaults
        </label>
        {k.auto && (
          <p className="note" style={{ marginTop: 6 }}>
            coarseness, GOP and mosh are left unset, so the family the probe picks fills them
            in. See “This device” for what they resolved to. Moving any of them takes over.
          </p>
        )}
      </div>

      <div className="row">
        <label>
          coarseness{' '}
          <b>
            {k.auto
              ? picked
                ? `auto ${picked.dials.coarseness}`
                : 'auto'
              : k.coarseness.toFixed(2)}
          </b>
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

      {/*
        The auto tag carries the resolved value once the stage has reported one, because
        otherwise these two sections show nothing at all on auto: the checkbox and slider
        below are hidden or stale, and "auto" alone does not say auto WHAT.
      */}
      <h2 style={{ marginTop: 18 }}>
        Keyframes{' '}
        {k.auto && <span className="auto-tag">auto{picked ? ` · GOP ${picked.dials.gop}` : ''}</span>}
      </h2>
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

      <h2 style={{ marginTop: 18 }}>
        Mosh{' '}
        {k.auto && (
          <span className="auto-tag">auto{picked ? ` · ${describeMosh(picked.dials.mosh)}` : ''}</span>
        )}
      </h2>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={k.mosh} onChange={(e) => set({ mosh: e.target.checked })} />
          drop chunks before the decoder
        </label>
      </div>
      {!k.auto && k.mosh && k.gopInfinite && k.dropDeltaChance === 0 && (
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
              keep every Nth keyframe <b>{k.keepEveryNthKeyframe || 'never'}</b>
            </label>
            <input
              type="range" min={0} max={8} step={1} value={k.keepEveryNthKeyframe}
              onChange={(e) => set({ keepEveryNthKeyframe: +e.target.value })}
            />
            <p className="note">
              0 never recovers: on AVC/HEVC the decoder survives a dropped keyframe, so error
              only accumulates. 2 snaps the picture back to clean every ~1.3s at GOP 20.
            </p>
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
