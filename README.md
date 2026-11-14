# ALMOST VISIBLE

*An encounter with the imperceptible.* A five-minute, five-chapter interactive audiovisual piece
for the browser. Its one idea is that **sound reveals form**: undisturbed space is black, every
sounding pitch is a wave source, and where the waves superpose, glass-like matter appears.

Everything is procedural. There are no textures, no samples and no model files: the image is
drawn with Three.js shaders and the sound is synthesised with Tone.js / Web Audio, both driven
by one shared model of the sounding sources.

- Creative direction: [`docs/DIRECTION.md`](docs/DIRECTION.md)
- The signature material and how sound drives it: [`docs/RESONANT-MATTER.md`](docs/RESONANT-MATTER.md)
- The instrument (signal flow, every parameter mapping): [`src/audio/README.md`](src/audio/README.md)

## Run

Requires Node 18 or newer.

```sh
npm install
npm run dev        # http://localhost:5173/           the piece
                   # http://localhost:5173/matter.html  the material on its own (proof page)
npm run build      # typecheck, then build both pages into dist/
npm run preview    # serve dist/
npm test           # vitest: puzzles, journey / director, audio engine (no browser needed)
npm run typecheck  # tsc --noEmit
```

`dist/` uses relative URLs (`base: './'`), so it can be served from any folder of a static host.

## The journey

| | Chapter | Target | What the visitor does | What it becomes |
|---|---|---|---|---|
| I | The First Signal | 0:35 | finds and wakes three hidden resonators | the darkness folds into an interference surface |
| II | The Space Between | 0:55 | draws a detuned voice along its path until the beating stops | one coherent membrane |
| III | Hidden Order | 1:05 | brings the three fragments that belong together into their figure | a lattice unfolds from it |
| IV | The Living Composition | 1:20 | gives Earth, Air and Light each their own place and register | one breathing sculpture |
| V | The Imperceptible | 1:05 | plays the remembered world as an instrument, then touches the last point of light | iridescence, then nothing |

Nobody can get stuck. Each chapter has a target length; a visitor who falls behind receives one
poetic hint, then visible guidance, and finally the world completes the puzzle by itself. A visit
with no input at all still runs to the end (in about six minutes instead of five).

Each visit has its own harmonic world, derived from a seed: a root between 46 and 62 Hz and one
of five just-intoned modes. Everything the visitor does is remembered and returns in chapter V.

## Controls

| Input | Effect |
|---|---|
| Move the pointer | matter leans toward it; hidden things answer when it comes near |
| Click / tap an object | strike it: a tone and a wavefront |
| Drag | move an object (it follows on a spring and settles when released) |
| Wheel | turn the object under the pointer if it can turn, otherwise move it in depth |
| Shift + wheel, or two-finger pinch | move it in depth |
| Two-finger twist | turn it |
| Tab / Shift+Tab | move keyboard focus between the objects in the field |
| Arrow keys | move the focused object |
| W / S | move it further away / nearer |
| Q / E | turn it (hold Shift for fine steps) |
| Enter or Space | strike the focused object; on the title card, begin |
| M · P · R | mute · pause · restart with the same seed |

The three buttons at the edge of the frame (Sound, Pause, Restart) do the same as M, P and R.
Sound and puzzle events are also written as short captions and announced to screen readers.
With `prefers-reduced-motion` the camera does not drift, idle motion all but stops and the grain
is frozen; directed transitions remain.

## URL parameters

| Parameter | Effect |
|---|---|
| `?seed=N` | fixed harmonic world (Reenter then walks a deterministic sequence from it) |
| `?chapter=N` | `1`–`5`: after Begin, start at that chapter |
| `?lite` | force the reduced tier (otherwise chosen for coarse pointers and small screens) |
| `?static` | show the static fallback instead of the live piece |
| `?autostart=1` | development server only: begin at once, without the title card and without sound |

The proof page `matter.html` takes `?seed=N`, `?lite`, `?variant=membrane|body|crystal|earth|air|light`
and `?paused`. Its keys: `1`–`6` variant, `S` sweep colour, `C` coherence, `D` detune one source,
`R` replay the reveal, Space pause; click to strike.

### Development harness

On the development server the page exposes `window.__av`:

```js
__av.begin(seed?, chapter?)   // as pressing Begin, without audio; chapter is 1..5
__av.step(n, dt = 1/60)       // stop requestAnimationFrame and run n frames synchronously
__av.resume()                 // hand the loop back to requestAnimationFrame
__av.director / .bridge / .stage / .audio / .interaction / .memory / .ctx / .chapters / .ui / .seed
```

`begin` and `step` do not depend on `requestAnimationFrame`, so the piece can be driven
deterministically in a hidden or headless tab. `matter.html` has the same idea as `window.__matter`.

## Browser support

- **WebGL 2** is required (Three.js r170), with half-float render targets. Without it, or if the
  context is lost, a static composition is shown instead.
- **Web Audio** is optional. If it cannot start, the piece says so once and runs silent: the image
  is driven by the same modelled sources either way.
- The code targets ES2020 and current evergreen browsers: Chrome / Edge, Firefox, and Safari 15+
  on desktop and mobile. Phones and tablets get the lite tier: half the lamellae, four wave terms
  instead of eight, no dispersion, half-resolution bloom, render scale capped at 1.5.
- Render scale adapts to the measured frame time (between 0.6× and 2× CSS pixels).

## Structure

```
index.html            the piece: canvas, title / ending cards, captions, controls, static fallback
matter.html           proof page for the material alone
src/
  main.ts             boot, frame loop, pause / visibility, fallback, development harness
  style.css           the typographic layer
  core/
    contracts.ts      every interface the modules are written against
    harmony.ts        seed → root + just-intoned mode
    bridge.ts         the audio ⇄ visual bus: modelled wave sources, phase, synthesised spectrum
    memory.ts         what the visitor did (returns in chapter V)
    math.ts           damp, ease, springs, PRNG
    Interaction.ts    pointer / touch / keyboard → hover, press, sprung drag, rotate
    Director.ts       the clock: enters, paces, assists and retires the chapters
    journey.test.ts   headless smoke test of the whole journey's logic
  chapters/           Chapter1.ts … Chapter5.ts (scene, interaction and sound of each chapter)
  puzzles/            pure puzzle logic + tests: resonators (I), tuning (II), constellation (III), balance (IV)
  render/
    Stage.ts          renderer, composer (scene → bloom → optical composite), adaptive resolution
    CameraRig.ts      the directed camera
    OpticalCompositePass.ts   exposure, filmic shoulder, dispersion, vignette, fade, grain
    Void.ts           the near-black environment
    materials.ts      createMatter / createFilament / createVolumeField / createParticles
    shared.ts         Bridge → the one set of shared uniforms (syncShared)
    keepalive.ts      keeps the shader programs alive across chapter changes
    glsl/             the shaders: common wave field, studio lights, matter, filament, volume, particles
  audio/              the instrument (see its README) + a whole-journey engine test
  ui/Interface.ts     title / ending cards, captions, hints, controls, live region
  proof/matter.ts     the proof page
docs/
  DIRECTION.md        creative direction
  RESONANT-MATTER.md  the material, and how each sound parameter drives the image
```

### How a frame is put together

```
interaction.update   pointer / keys → callbacks into the chapter's interactives
stepBridge           advance the modelled sources (amplitude, phase, beat crawl)
audio.update         analyser → bridge (only when sound is actually running)
director.update      pacing, assistance; the active chapter writes bridge, audio and matter params
rig.update           camera
ui.update            captions
stage.render         bridge → shared uniforms, then scene → bloom → composite
```

The chapters never talk to each other. They share the `Bridge` (eight wave-source slots plus a
handful of scalars), the `Memory`, and, between IV and V, one explicit hand-off record so that
the cut between them cannot be seen.

*This is an artistic interpretation of wave phenomena, not a simulation of reality.*
