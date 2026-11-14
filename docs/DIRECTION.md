# ALMOST VISIBLE — Creative Direction

*An encounter with the imperceptible.* A five-minute, five-chapter interactive audiovisual journey.
Central idea: **sound reveals form.** Undisturbed space is black. Every sounding pitch is a wave
source; where waves superpose, matter appears.

This is an artistic interpretation of wave phenomena, not a simulation of reality.

## 1. Resonant Matter (the signature)

Reference supplied by the client: stacked sheets of clear glass flowing like fabric on pure black —
many parallel lamellae following one undulating surface, each with a crisp white cut edge, and
inside them deep refraction: saturated ultramarine, teal/cyan and warm amber-champagne pooled in
soft bands, with regions that go fully dark. It reads as glass, liquid and silk at once.

Our material is that, driven by sound:

- **Lamellae.** One wave-displaced surface, rendered as N thin parallel sheets offset along the
  normal (instanced). Sheet count and separation open with harmonic complexity: one pitch = one
  barely-there sheet; a chord = a stack that fans apart.
- **Shape from superposition.** Displacement is `Σ Aᵢ·sin(kᵢ·|x−sᵢ| − ωt + φᵢ)` over the modelled
  wave sources (bridge.waves). `kᵢ ∝ pitch`, `Aᵢ` = level, `φᵢ` = explicitly modelled phase.
  In tune → nodal lines stand still. Detuned → the pattern crawls at the beat rate.
- **Glass optics, procedurally.** Analytic normal from the field gradient. Reflection + refraction
  vectors sample a *procedural* studio environment (soft light strips), never a texture.
  Fresnel rim; a bright thin line on every sheet's cut edge; absorption that lets the interior go
  genuinely dark. Black stays black: no additive haze, no fog of bloom.
- **Colour is earned.** Thin-film term keyed to the interference amplitude and view angle.
  `bridge.spectral = 0` → graphite, silver, ivory only. Rising → ice blue, then champagne, and only
  at the two great moments (end of IV, climax of V) the full ultramarine/teal/amber of the reference.
- **Silence dissolves.** `bridge.silence → 1`: sheets thin, separate into filaments, and go out,
  highs first.

Variants share one shader: `membrane` (wide sheets), `body` (small closed objects), `crystal`
(faceted, condensed), `earth` (thick, slow, low k), `air` (many faint fast sheets, noisy),
`light` (sharp, sparse, high k, glints).

## 2. Interaction grammar

Hover: matter leans toward the pointer and brightens its rim. Press: excite (a strike, a radial
wavefront). Drag: object follows on a spring with inertia, pitch/mix follow position continuously.
Release: soft settle; magnetic snap near a harmonic solution. Nothing jumps. The world teaches
itself; text is one line per chapter plus, only if needed, one poetic hint.

## 3. Progression: POINT → LINE → SURFACE → VOLUME → FIELD

| | Chapter | Time | Puzzle | Signature | Colour |
|---|---|---|---|---|---|
| I | The First Signal | 0:00–0:35 | wake three hidden resonators | darkness folds into an interference surface | monochrome |
| II | The Space Between | 0:35–1:30 | drag the detuned body until the beating stops | patterns resolve into one coherent membrane | ivory + faint blue |
| III | Hidden Order | 1:30–2:35 | assemble a three-fragment constellation | constellation unfolds into a vast lattice | silver + warmth |
| IV | The Living Composition | 2:35–3:55 | place Earth / Air / Light so none masks another | three fields merge into a breathing sculpture | selective spectral |
| V | The Imperceptible | 3:55–5:00 | none — free play, then touch the last point | the great fabric of interfering waves, then dissolution | iridescent → nothing |

Adaptive assistance keeps the pace: each chapter has a target length; an unsolved puzzle receives a
poetic hint, then visible guidance, then quietly completes itself.

## 4. Sonic architecture

One harmonic system per visit (seeded): a root between 46–62 Hz and a just-intoned modal collection.
Everything — drone, resonators, tunable bodies, fragments, the three ecosystems, the sparse melody —
is drawn from it. Wide dynamic range, long silences, no percussion, no risers. Each chapter adds one
instrument: I strikes + sub; II sustained beating voices; III FM fragments + filaments; IV Earth /
Air / Light; V the remembered composition, then highs → melody → drone → silence.

## 5. Emotional arc

Uncertainty → noticing → the relief of consonance → the awe of order → the calm of balance →
the realisation *"you have been composing all along"* → letting go.

## 6. Performance constraints

60 fps on a modern laptop at ≤ 2× pixel ratio; adaptive render scale; a `lite` tier (fewer sheets,
fewer wave terms, no dispersion) for tablets and phones. No per-frame allocation. Shared uniforms.
One composer chain: scene → restrained bloom → optical composite (filmic tone map, slight
dispersion, grain). Reduced-motion: no camera drift, slower transitions, no flashes ever.
