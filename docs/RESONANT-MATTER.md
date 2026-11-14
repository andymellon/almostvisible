# Resonant Matter

The one material of ALMOST VISIBLE. It reads as glass, liquid and silk at once: many thin, clear
sheets stacked on one undulating surface, each ending in a crisp pale cut edge, with refracted
light pooling inside them and large regions that stay completely black.

It is not a picture of sound laid over a shape. The shape *is* the sound: the same handful of
modelled wave sources that the instrument sonifies displace the surface, decide how many sheets
exist, where each sheet is cut, where colour is allowed, and when everything lets go.

*An artistic interpretation of wave phenomena, not a simulation.*

## What it is made of

**One surface, many lamellae.** A tessellated surface is drawn N times (instanced). Each copy is a
lamella, offset along the surface normal. One sounding pitch shows one barely-there sheet; as more
pitches sound, the stack unfolds and fans apart. Lamellae that have not unfolded are not drawn.

**Shape from superposition.** Every wave source `i` contributes
`aᵢ · sin(kᵢ·rᵢ − φᵢ) · 1/(1 + 0.018·rᵢ²)` at distance `rᵢ`. The sum displaces the surface along
its normal, and its analytic gradient gives the shading normal: there is no normal map and no
finite differencing.

**The interference envelope.** Alongside the surface height, the shader keeps the complex sum of
the sources. Its magnitude is where the sources agree. That envelope does three things: it opens
the fan locally, it sets the thin-film thickness, and above all it *cuts* the sheets — every
lamella ends on its own iso-contour of the envelope, so the stack reads as a bundle of parallel
edge lines that fan apart and pinch together. While the sources are in tune the bundle stands
still. When one is detuned it crawls, at a rate proportional to the detune.

**Glass, procedurally.** Refraction (index 1.45) and reflection look into a procedural studio of
six soft lights on black: four strips behind the matter, two small lights in front. An open sheet
is optically absent where it is flat: only the tilt the waves give it bends light, so colour pools
on slopes and undisturbed regions stay black. Closed bodies refract with their true normal and
carry a silhouette line instead of cut edges. Absorption grows with the path through the stack, so
the interior can go genuinely dark. Output is premultiplied alpha with a low alpha per sheet:
matter can darken what is behind it, and nothing is ever added as haze.

**Variants** are presets over the one shader, so any variant works on any shape:

| Variant | Character |
|---|---|
| `membrane` | wide open sheets, 14 lamellae: the interference surface itself |
| `body` | a small closed bead of nested shells that keeps its form and breathes |
| `crystal` | faceted and condensed, hard optics, facet edges drawn |
| `earth` | thick, slow, long waves, heavy absorption: dark glass |
| `air` | many faint fast shells, noisy and almost weightless |
| `light` | sharp, sparse, short waves, strong glints |

Three companions share its uniforms and its wave field: **filaments** (a luminous strand between
two points), the **volume field** (the same superposition raymarched in three dimensions as thin
iso-phase skins that survive only where the sources agree) and **dust**.

## From sound to image

There is one bus between sound and image, the `Bridge` (`src/core/bridge.ts`). Chapters write the
wave sources and a few scalars; the audio engine sonifies the same sources and, when sound is
running, writes back what the output actually measures. `syncShared` (`src/render/shared.ts`)
copies the bridge into one set of uniforms that every material reads.

If sound cannot start, or is muted, the measured values are replaced by ones derived from the
modelled sources, so the image never depends on audio being available.

### The wave sources (`bridge.waves[0..7]`)

Each slot is one sounding thing: a resonator, a tunable body, a fragment, a sound field. The slot
index is also the audio voice id.

| Sound | Image | Where |
|---|---|---|
| **Pitch** `freq` | Wave number `k = 1.5 · (f / fundamental)^0.62` radians per world unit: the root makes swells about four units long, a pitch four octaves up makes ripples under one unit. Higher pitches also move the surface less (`amplitude ∝ ratio^−0.42`), so fine ripples ride the broad swell instead of shredding it. | `shared.ts` |
| **Level** `level` | Amplitude of that source's waves, after smoothing (rises in about 0.2 s, releases in about 0.6 s). A source is drawn exactly as far as it sounds. | `bridge.ts` |
| **Position** | Centre of its rings. Dragging a sounding body moves the whole pattern. | `glsl/common.ts` |
| **Tuning** | Every source's phase advances at a common 0.11 Hz, plus `0.16 × (f − nearest in-tune pitch)` Hz. In tune: all sources share the carrier and the interference figure stands still. Detuned: that source runs ahead or behind and the figure crawls. Audible beating is slowed by this factor so the eye can read it. | `bridge.ts` |
| **How many are sounding** | `complexity = smoothstep(0.6, 3.2, Σ level)` opens the fan: `fan = spread · (fanBase + (1 − fanBase) · complexity)`, and only `1 + 1.6 · fan · (N − 1)` lamellae are drawn. One pitch is one sheet; a chord is the full stack. | `shared.ts`, `glsl/matter.ts` |
| **Agreement between sources** | The interference envelope `|Σ bᵢ·e^{i(kᵢrᵢ − φᵢ)}|`, weighted toward the low partials so it stays broad under a dense chord. It cuts each lamella on its own contour, swells the stack apart, and sets the thin-film thickness (`orders = 0.85 + 1.9 · envelope`). | `glsl/matter.ts` |

### The measured signal

Taken from the analyser on the real output, or synthesised from the sources when there is none.

| Sound | Image | Where |
|---|---|---|
| **Loudness** `amplitude` (smoothed RMS) | Scales all displacement: `× (0.8 + 0.6 · amplitude)`. | `glsl/matter.ts` |
| **Bands** `low`, `mid`, `high` | Each source breathes with the band it sounds in: its amplitude is multiplied by `0.72 + 0.9 · band`, where the band is `low` below about 1.5–3.5 × the fundamental, `high` above about 4–9 ×, `mid` between. `low` also swells the near-black environment by up to a third. | `shared.ts`, `Void.ts` |
| **Note attacks** `attack`, `attackAt` | A rising edge launches a radial wavefront from the place of the strike: it travels at 2.6 units per second, displaces the surface as it passes and brightens the glass along the ring. Its strength is the value of `attack`; it fades over about five seconds. Three can be in flight at once. | `shared.ts`, `glsl/matter.ts` |

### The states a chapter writes

| Sound | Image | Where |
|---|---|---|
| **Stability** (rough and beating ↔ coherent) | `shimmer = 1 − stability` jitters the phase of each lamella against its neighbours and raises the slack noise: an unresolved sound makes the sheets tremble out of register; a resolved one lets them lie still. The same value detunes and roughens the instrument. | `glsl/matter.ts` |
| **Spectral** (monochrome ↔ iridescent) | Colour is earned. At 0 the studio lights are ivory, silver and graphite. At 0.35 ice blue enters the cool strips, at 0.65 champagne and pale teal, from 0.9 the full ultramarine, teal and amber. Refractive dispersion opens with it (index 1.45 splitting toward 1.42 / 1.49), absorption through the stack becomes colour-selective instead of neutral, and thin-film iridescence grows with `spectral²`. | `shared.ts`, `glsl/matter.ts` |
| **Silence** (the dissolution) | Highs go first: each source is gated out between `0.62 − 0.57 · order` and 0.3 above it, where `order` is its pitch in units of four octaves, so the finest ripples vanish while the swell remains. The fan closes (0.1 → 0.9), coherence falls and the sheets tear into strips (0.15 → 0.85), and the last matter is extinguished (0.6 → 1). | `shared.ts`, `glsl/matter.ts` |
| **Presence** | Master visibility of everything. | all shaders |

### What each object is told

Set per object by its chapter (`MatterParams`), usually straight from the puzzle's state.

| Parameter | Image |
|---|---|
| `reveal` | A front that travels across the object: crests near the centre appear first, troughs at the rim last, and the glass thickens behind the front. |
| `excite` | The answer to a touch: a ripple that leaves the object's centre as the impulse decays, and a brief brightening. |
| `hover` | The surface leans toward the pointer ray and its rim brightens. |
| `tension` | Slack ↔ taut. Slack matter carries slow silk-like noise, moves further and shears between sheets; taut matter is still and glassy. |
| `coherence` | 1: whole sheets. Falling: long slits open, shared by the whole stack. Below about 0.4: ribbons that tear loose and drift. 0: a sparse drift of glass filaments. |
| `freq` | The object's own pitch as a standing figure on it: more lobes for every octave above the fundamental. |
| `warmth` | Leans the balance between the cool and the warm studio lights. |
| `spread` | How far the lamellae may fan apart. |

## How the chapters use it

| Chapter | The puzzle's state | What the matter does |
|---|---|---|
| I | resonators awake (0–3) | each adds a source: reveal, coherence and spread of the membrane rise step by step, then fold into one surface |
| II | cents between the third voice and its resting pitch | the figure crawls at the beat rate; tension, coherence and filaments rise as the beating slows; in tune, everything stands still and opens |
| III | how close each bonded pair is to its ideal distance | filaments appear and tighten; at the solution the lattice (volume field) unfolds from the figure |
| IV | masking between Earth, Air and Light | the membrane's tension and coherence *are* the balance: torn and turbulent when the fields mask each other, taut when each has its own space |
| V | time | full spectral colour for one moment, then `silence` takes everything, highs first |

## Tiers

The lite tier (phones, tablets, `?lite`) halves the lamellae with compensated opacity, evaluates
four wave terms instead of eight (sources fade in and out of the strongest four without a pop),
drops dispersion and the second noise octave, and raymarches the volume in 14 steps instead of 24.
