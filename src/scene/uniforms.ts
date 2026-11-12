import { Matrix3, Vector3, Vector4 } from 'three';
import { TRAIL_N } from '../shaders/common';

/**
 * One set of uniform objects, shared by reference across every material.
 * Writing a value here changes particles, membrane, filaments and traces at once.
 */
export const shared = {
  uTime: { value: 0 },
  uMorph: { value: new Vector3(1, 0, 0) },
  uDeform: { value: 0.1 },
  uFormRot: { value: new Matrix3() },
  uFocus: { value: new Vector3() },
  uPull: { value: 0 },
  uCoherence: { value: 0 },
  uEnergy: { value: 0 },
  uTurb: { value: 0 },
  uHold: { value: 0 },
  uColor: { value: 0 },
  uMemory: { value: 0 },
  uStill: { value: 0 },
  uFormVis: { value: 1 },
  uDetail: { value: 0 },
  uCamDir: { value: new Vector3(0, 0, -1) },
  uFocusDist: { value: 6 },
  uPixelRatio: { value: 1 },
  uViewH: { value: 1000 },
  uTrail: { value: Array.from({ length: TRAIL_N }, () => new Vector4(0, 0, 0, 0)) },
};

export type Quality = { lite: boolean; reduced: boolean };
