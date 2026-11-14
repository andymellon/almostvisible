# src/audio — the instrument

`createAudioEngine(bridge: Bridge): AudioEngine` (`AudioEngine.ts`). Everything is synthesised:
no samples, no impulse-response files. Tone.js owns the AudioContext, the Transport, the limiter,
the convolver and the mute gain; every voice is raw Web Audio created through Tone's context, so
envelopes and pitch glides are sample-accurate and have no look-ahead latency.

Nothing is constructed before `start()`. Until then (and forever, if audio is unavailable) every
method is a no-op — except that `strike()` still marks `bridge.attack`, and the engine remembers
the drone, fields, stability, memory, finale and sustained voices it was asked for, so a context
that unlocks late joins the piece where it is.

## Files

| file | what it is |
|---|---|
| `AudioEngine.ts` | the contract: life-cycle, desired state, dissolve schedule |
| `graph.ts` | `Rig` (context, synthesised pink noise, periodic waves, node life-cycle), `Patch`, `Smooth` (click-free params), world → stage placement |
| `space.ts` | buses, reverb, multi-tap delay, roughness, dissolve stage, limiter, ceiling, analysis taps |
| `analysis.ts` | output → `bridge.amplitude / centroid / low / mid / high`, `peakDb` |
| `drone.ts` | sub drone |
| `voices.ts` | 8 sustained tunable voices (ids = `bridge.waves` slots) |
| `strikes.ts` | pool of 10 one-shot FM resonators |
| `fields.ts` | Earth / Air / Light |
| `notes.ts`, `gestures.ts` | scheduled soft tones; the five `resolve()` gestures |
| `finale.ts` | chapter V: memory → composition |
| `quiet.ts` | silences Tone's console banner (must stay the first import of `AudioEngine.ts`) |
| `AudioEngine.test.ts` | whole-journey smoke test against a fake Web Audio graph (`npx vitest run src/audio`) |

## Signal flow

```
 drone sub ───────────────────────────────┐
 voices ─ pitch-tracking LP ─ amp ─ depth LP ─ pan ─ voice bus ─ soft non-linearity ─┤
 strikes (10 × FM pair + partial) ─ depth LP ─ pan ─────────────────────────────────┤→ DRY ──────────────┐
 notes (resolve gestures) ─ amp ─ pan ──────────────────────────────────────────────┘                    │
                                                                                                         │
 drone body ─ LP ─ wandering peak ──────────────┐                                                        │
 EARTH  sine pairs + noise resonances ─ LP ─ tremolo ┤                                                   │
 AIR    breath band + formant + 8 grain voices ─ HP  ┤→ TEXTURE ─ × (1 + roughness AM 23 / 31.7 Hz) ─────┤
 LIGHT  6 sine partials ─ HP                         ┤                                                   │
 finale pad (beating twins, per-tone LFO) ───────────┘                                                   │
                                                                                                         │
 per-source sends (depth, FieldMix.diffusion via 8–130 ms pre-delay) ─┐                                  │
 DRY + TEXTURE ─ bloom send (stability) ──────────────────────────────┤                                  │
                                                                      ▼                                  │
        REVERB IN ─ 19 ms ─ Convolver (procedural stereo IR, 6.5 s, RT60 ≈ 5.6 s)                        │
                  ─ LP (opens with stability) ─ HP 110 Hz ─ return ─ swell (resolve gestures) ───────────┤
        DELAY IN ─ 3 taps 293 / 461 / 719 ms (LP, panned L / R / C) ⟲ 0.33 feedback, HP 180 Hz ──────────┤
                  └─ 0.35 → REVERB IN                                                                    │
                                                                                                         ▼
 SUM (MASTER_GAIN) ─ dissolve LP ─ dissolve gain ─ HP 22 Hz ─ limiter (Tone.Compressor −8 dB, 20:1, 3 ms / 120 ms)
     ─ make-up trim ─ ceiling (WaveShaper: linear below 0.6, tanh shoulder, |out| ≤ 0.891 = −1 dBFS)
     ─┬─ analysers: mono sum (spectrum) · L · R (peak, RMS)
      └─ pause gate ─ mute (Tone.Gain) ─ destination
```

Envelope rule: gains are only ever moved with `setTargetAtTime`. Cancelling such a timeline never
makes the value jump, so retriggering, stealing, `reset()` and `dissolve()` cannot click.

## Harmony

Every pitch comes from the `Harmony` given to `setHarmony` (drone, Earth pairs and resonances, Air
grain pitches, Light partials and notes, all five gestures, the whole finale). `voiceOn/voiceSet`
and `strike` play the frequency they are given — those come from the chapters, which draw them from
the same Harmony. `setHarmony` may be called again at any time: running layers glide to the new
root (0.3 s) and a compiled finale is recompiled.

Stochastic events (grains, Light notes, finale rests) use a private generator seeded by **one**
draw from `harmony.rand()` per Harmony. The shared generator is therefore advanced exactly once by
the audio engine, never per frame, so what other modules draw from it stays reproducible per seed.

## Parameter mappings

### `setDrone(level, brightness)`
Five detuned pairs on root ×1 (sine, the only layer on the dry bus), ×2, ×3, ×1 (24-harmonic
"reed"), ×4. Each pair beats at 0.05–0.29 Hz and its halves sit left and right.

| input | effect |
|---|---|
| `level` | output gain `0.12 · level^1.5`, time constant 0.7 s; 0 fades out |
| `brightness` | low-pass `root · (3.4 + 12·b)`, resonant peak gain `5 + 6·b` dB |
| (always) | peak wanders `root · 5.5 ± 2.8` and the low-pass `± root · 1.1` on LFOs of 59 / 24 / 34 s |
| stability | pair detune widens by up to 0.8–3.1 Hz at stability 0 |

### `voiceOn / voiceSet / voiceOff`
One pitch signal per voice (ConstantSource) drives every oscillator and pitch-tracking filter.

| input | effect |
|---|---|
| `freq` | glide with time constant 18 ms (within 2 cents after ≈ 60–80 ms); clamped 16 Hz – 8 kHz |
| `level` | gain `0.09 · trim · level · (1 − 0.42·depth)`; attack time constant 120 ms, changes 60 ms |
| `brightness` (default 0.5) | low-pass at `pitch · (base + span·b)`; `fm`: index 0.25 → 1.85; `breath`: more air |
| `pos.x` | equal-power pan `0.94 · tanh(x / 2.4)` |
| `pos.z` | depth `clamp(0.3 − z / 7)`: low-pass `1.5 kHz · 2^(3.4·(1 − depth))`, reverb send `0.15 + 0.5·depth` |
| `voiceOff(id, release)` | −40 dB after `release` s (default 1.2), nodes freed afterwards |
| timbre `pure` | near-sine with soft harmonics 2–6 |
| timbre `glass` | odd-weighted periodic wave |
| timbre `fm` | carrier : modulator 1 : 2 |
| timbre `breath` | quiet tone inside noise resonated at the pitch and its octave |

`voiceOn` on a sounding id with the same timbre only updates it; a different timbre cross-fades.
Beating is real: the timbres carry low harmonics (a mistuned fifth beats at `3·f₁ − 2·f₂`) and the
voice bus has a very mild non-linearity that adds combination tones.

### `strike(freq, { velocity, pos, timbre })`
Sets `bridge.attack = 1` and copies `pos` into `bridge.attackAt` (also when audio is off). Ten
always-running voices; a free one is taken, otherwise the quietest is closed over 20 ms and reused.

| timbre | recipe |
|---|---|
| `bell` (default) | C : M = 1 : 1.4, index 2.2 → 0.2 over 0.35 s, partial at 2.76×, decay time constant 1.7 s, reverb + delay |
| `glass` | C : M = 1 : 3, short bright index burst, partial at 5.4×, decay 0.3 s, more delay |
| `sub` | folded below 130 Hz, C : M = 1 : 0.5, 30 ms onset, decay 0.85 s, almost dry |

`velocity` → peak `∝ v^1.2` and FM index `∝ 0.4 + 0.6·v`; index is reduced above 900 Hz. `pos` as for voices.

### `setFields({ earth, air, light })`

| | EARTH | AIR | LIGHT |
|---|---|---|---|
| material | sine pairs on root ×1, ×1.5, ×2; noise through Q 28 resonances on harmonics 2·3·4·6 | breath band + formant; grains = 70–270 ms windowed noise bursts through a Q 32 resonance on a note of the mode | sines on degrees 0·4 (oct 4), 0·2·4 (oct 5), 1 (oct 6); rare single glass notes walking the mode |
| `level` | gain `0.11 · l^1.4` | gain `0.3 · l^1.4`; grain rate `l · (3 + 10·b) · (0.6 + 0.8·m)` per s | gain `0.036 · l^1.4`; a note every `(4…13 s) / (0.5 + l)` |
| `brightness` | low-pass `root · (3 + 10·b)` | band centre `root · 2^(3.5 + 2.2·b)`, formant 2.3× above, grain register | how many of the six partials are open (bottom-up) |
| `diffusion` | reverb send 0.08 → 0.85, pre-delay 8 → 130 ms, dry −35 % | same | same, and the depth of its notes |
| `modulation` | tremolo depth 0 → 0.5, rate 0.07 → 0.32 Hz | formant sweep, breath depth, grain stereo scatter | tremolo depth and rate, vibrato up to ±0.3 % at 4.7 Hz |

A level of 0 silences the field. Stability 0 detunes the Earth pairs (up to +2.1 Hz) and the Light
partials (± 14 cents).

### `setStability(s)`

| s → 0 | s → 1 |
|---|---|
| texture bus amplitude-modulated at 23 and 31.7 Hz, depth `0.3 · (1 − s)²` | none |
| drone / Earth / pad pairs detuned wider, Light out of tune with itself | slow pure beats only |
| reverb return 0.6, darker (3.2 kHz), bloom send 0.03 | from s = 0.55: return → 1.02, tone → 9.4 kHz, bloom send → 0.23 |

### `resolve(kind)` — composed, in the mode (degree 4 = 3/2)

| kind | gesture |
|---|---|
| `signal` | root, fifth and octave enter one by one over a low octave; a sub resonance lands beneath them (≈ 6 s) |
| `consonance` | bottom-up bloom into pure stacked fifths 2 · 3 · 4 · 6 · 9 · 12 · 18 × root, slow swell of the room, release (≈ 10 s) |
| `lattice` | 11-note overtone-like arpeggio in glass, accelerating, fanned alternately left / right to the edges; a high fifth is left standing |
| `balance` | Earth (low fifth), Air (two breath bands) and Light (three high sines) as one body taking two breaths |
| `final` | one soft struck bowl: harmonics 1·2·3·4·6·8 of the root plus a sub strike. After `dissolve()` it reopens the closed master for this one sound and shuts it for good 22 s later |

### `setMemory(m)` + `setFinale(intensity)`

| memory | becomes |
|---|---|
| `resonators` | the melodic cell (degrees in waking order) |
| `tuning.ratio` | governing interval: the pad's low dyad, the halo stacked above it, and the "answer" 0.24 s after long notes and phrase ends. Within 6 cents of the mode it is made pure; otherwise it stays as the visitor left it, and beats |
| `tuning.seconds` | tempo factor 0.75 … 1.6 (a slow tuner gets a slower piece) |
| `constellation.positions` | pan / depth of the pad's middle voices; melodic events travel through them in order (and leave a soft `bridge.attack` 0.35–0.75 at that world position) |
| `constellation.degrees` | the pad's middle voices; the transpositions the cell cycles through |
| `balance` | Earth / Air / Light return at the remembered mix × `0.85 · intensity`; their levels weight the pad's low / middle / high tones and the melody's velocity |
| `gestures` | inter-onset intervals (0.12–20 s, last 32), rescaled so the median is 2.4 s and clamped to 0.55–7.5 s, are the gaps between melodic events. Fewer than three usable intervals → a fixed pattern rotated by the cell |

`intensity`: pad gain `0.07 · i^1.2`, remembered fields, velocity `0.22 + 0.4·i`, event spacing
`÷ (0.7 + 0.6·i)`, fewer rests. Long gaps play low bells, short gaps high glass.

### `dissolve(seconds)` — fractions of `seconds`

| what | fades over |
|---|---|
| master low-pass → 140 Hz | from 0 (time constant 0.16) |
| Light | 0 – 0.30 |
| Air | 0.10 – 0.50 |
| sustained voices | 0.15 – 0.55 |
| melodic events | none start after 0.40 |
| finale pad | 0.30 – 0.68 |
| Earth | 0.35 – 0.75 |
| drone | 0.50 – 0.92 |
| master gain | from 0.60, exactly 0 at 1.0 |

### Analysis → bridge (`update(dt)`, once per frame)

| bridge | from |
|---|---|
| `amplitude` | RMS of the last 43 ms (L and R), `(dB + 58) / 46` |
| `low` / `mid` / `high` | band power 28–180 Hz / 180 Hz–1.8 kHz / 1.8–12 kHz, `(dB + 54) / 42`, `(dB + 60) / 44`, `(dB + 72) / 46` |
| `centroid` | magnitude-weighted mean log-frequency (+3 dB / oct tilt), 50 Hz → 0 … 5 kHz → 1 |
| `measured` | true while the context runs, not paused, not muted; otherwise false and nothing is written |

Fast attack / slower release smoothing on all five. No phase is derived from the spectrum.
`peakDb`: largest sample of either output channel after the ceiling (before pause / mute) since
`reset()`. It is a sample peak; the −1 dBFS ceiling leaves room for inter-sample overshoot.

### Life-cycle

| call | behaviour |
|---|---|
| `start()` | builds the graph synchronously inside the gesture, awaits `Tone.start()`; resolves `false` (never throws) without Web Audio, on any construction error, or if the context is not running after 8 s |
| `setMuted` | master ramp, 90 ms down / 250 ms up |
| `setPaused(true)` | gate closes (12 ms), Transport pauses, context suspends 90 ms later; `false` resumes all three |
| `reset()` | voices, strikes, notes, drone, fields and finale released in ≤ 0.25 s; master ducked for 0.3 s while the reverb and delay lines are replaced (no tail survives); dissolve cleared; stability back to 0.7; `peakDb` cleared |
| `dispose()` | stops every source, disconnects every node, disposes the Tone nodes. The shared Tone context itself is left alone |

## Levels

`MASTER_GAIN` in `space.ts` is the single loudness control; the constants in `analysis.ts` assume
it (move them together). The piece is deliberately quiet: a sustained voice at level 0.5 peaks near
−23 dBFS at the output, and the full chapter V texture with every pitched partial in phase sums to about
−11.5 dBFS dry, under the limiter threshold. The ceiling bounds every output sample at −1 dBFS
whatever is played.
