export default {
  id: 'ghost-radio',
  async activate(api) {
    let enabled = true;
    let phase = 0;
    let depth = 900;
    let rate = 0.025;
    return {
      setParameter(name, value) {
        if (name === 'depth') depth = Math.max(0, Math.min(2200, Number(value) || 0));
        if (name === 'rate') rate = Math.max(0.005, Math.min(0.12, Number(value) || 0.025));
      },
      onSignal(signal) {
        if (!enabled || !api.filter) return;
        if (!signal.voiced) { api.filter.setOffset(0); return; }
        phase += rate;
        const wobble = Math.sin(phase) * depth;
        const spectralPull = (signal.brightness || 0) * 700;
        api.filter.setOffset(wobble - spectralPull);
      },
      deactivate() {
        enabled = false;
        api.filter?.setOffset(0);
      }
    };
  }
};
