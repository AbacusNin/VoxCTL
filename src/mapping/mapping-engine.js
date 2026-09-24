const SOURCES = {
  'voice.rms': f => clamp((f.rms - (f.noiseGate || 0.008)) / 0.13),
  'voice.brightness': f => clamp(f.brightness || 0),
  'voice.noisiness': f => clamp(f.noisiness || 0),
  'voice.pitchConfidence': f => clamp(f.confidence || 0),
  'voice.vibratoDepth': f => clamp((f.vibratoDepth || 0) / 90),
  'voice.vibratoRate': f => clamp(((f.vibratoRate || 0) - 2) / 8),
  'voice.formant1': f => clamp(((f.formant1 || 0) - 250) / 750),
  'voice.formant2': f => clamp(((f.formant2 || 0) - 800) / 2400)
};

export const MAPPING_SOURCES = Object.keys(SOURCES);
export const MAPPING_DESTINATIONS = [
  'synth.filterCutoff',
  'synth.detune',
  'fx.delayMix',
  'fx.reverbMix',
  'master.gain'
];

const SAFE_ID = /^[\w:-]{1,64}$/;

function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }

export class MappingEngine {
  constructor(mappings = []) { this.setMappings(mappings); }
  setMappings(mappings) {
    // Presets come from storage or imported files: a non-array or a null
    // entry used to throw inside preset load, so both are skipped.
    const list = Array.isArray(mappings) ? mappings : [];
    this.mappings = list.filter(m => m && typeof m === 'object').map((m, index) => ({
      // Ids land in markup attributes, so anything outside a plain token is replaced.
      id: SAFE_ID.test(String(m.id)) ? String(m.id) : `map-${index + 1}`,
      enabled: m.enabled !== false,
      source: MAPPING_SOURCES.includes(m.source) ? m.source : 'voice.brightness',
      destination: MAPPING_DESTINATIONS.includes(m.destination) ? m.destination : 'synth.filterCutoff',
      amount: Math.max(-100, Math.min(100, Number(m.amount) || 0)),
      curve: ['linear', 'square', 'sqrt'].includes(m.curve) ? m.curve : 'linear'
    }));
  }
  getMappings() { return this.mappings.map(m => ({ ...m })); }
  evaluate(features) {
    const output = Object.fromEntries(MAPPING_DESTINATIONS.map(dest => [dest, 0]));
    for (const mapping of this.mappings) {
      if (!mapping.enabled) continue;
      let value = SOURCES[mapping.source]?.(features) ?? 0;
      if (mapping.curve === 'square') value *= value;
      if (mapping.curve === 'sqrt') value = Math.sqrt(value);
      output[mapping.destination] += value * (mapping.amount / 100);
    }
    for (const key of Object.keys(output)) output[key] = Math.max(-1, Math.min(1, output[key]));
    return output;
  }
}
