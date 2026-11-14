/**
 * Program keepers — one never-drawn object of each material kind, alive for the whole session.
 *
 * three destroys a shader program when the last material that uses it is disposed. Every
 * chapter disposes all of its matter before the next one builds its own, so without this the
 * large Resonant Matter program (and the filament, volume and dust programs) would be thrown
 * away and compiled again at each chapter seam — a hitch exactly where the piece wants an
 * invisible cut (IV → V happens within one frame).
 *
 * The keepers hold a reference to each program instead. They are submitted to the renderer
 * every frame, which is what acquires (and, at boot, compiles) the program, but they draw
 * nothing by construction: an InstancedMesh with zero instances, or a geometry whose draw
 * range is empty. Their reveal is zero as well. Compilation therefore happens once, behind
 * the title card.
 */
import { BufferAttribute, BufferGeometry, Group, type InstancedMesh, type Mesh, type Object3D } from 'three';
import type { Quality } from '../core/contracts';
import { createFilament, createMatter, createParticles, createVolumeField } from './materials';

export interface ProgramKeepers {
  /** Add to the scene once; never remove while the stage lives. */
  readonly object: Object3D;
  dispose(): void;
}

export function createProgramKeepers(quality: Quality): ProgramKeepers {
  const empty = new BufferGeometry();
  empty.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  empty.setDrawRange(0, 0);

  // Every matter variant and shape shares one program (a variant is a preset of uniforms).
  const matter = createMatter('body', { shape: 'sphere', radius: 0.05, detail: 0, layers: 1, init: { reveal: 0 } }, quality);
  const filament = createFilament(quality);
  const volume = createVolumeField(quality);
  const particles = createParticles(1, quality);

  const group = new Group();
  group.name = 'program-keepers';
  group.add(matter.object, filament.object, volume.object, particles.object);

  // Make sure nothing can reach the screen, whatever the factories built.
  group.traverse((node) => {
    const drawable = node as Mesh;
    if (!drawable.material) return;
    drawable.frustumCulled = false;
    if ((drawable as InstancedMesh).isInstancedMesh) (drawable as InstancedMesh).count = 0;
    else drawable.geometry = empty;
  });

  return {
    object: group,
    dispose() {
      group.removeFromParent();
      matter.dispose();
      filament.dispose();
      volume.dispose();
      particles.dispose();
      empty.dispose();
    },
  };
}
