/**
 * Evaluated before Tone.js (it is the first import of AudioEngine.ts, and nothing else
 * in the project reaches Tone by another path): Tone prints a banner to the console when
 * its module is first evaluated unless this flag is already set. The piece says nothing
 * it was not asked to say.
 */
if (typeof window !== 'undefined') {
  (window as unknown as { TONE_SILENCE_LOGGING?: boolean }).TONE_SILENCE_LOGGING = true;
}

export {};
