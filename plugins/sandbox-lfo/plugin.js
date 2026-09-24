voxfluxSandbox.activate(api => {
  let phase = 0;
  let depth = 1200;
  let rate = 0.08;
  return {
    setParameter(name, value) {
      if (name === 'depth') depth = Math.max(0, Math.min(3000, Number(value) || 0));
      if (name === 'rate') rate = Math.max(0.01, Math.min(0.3, Number(value) || 0.08));
    },
    onSignal(signal) {
      if (!signal.voiced) { api.setCapability('synth.filter.offset', 0); return; }
      phase += rate;
      api.setCapability('synth.filter.offset', Math.sin(phase) * depth);
    },
    deactivate() { api.setCapability('synth.filter.offset', 0); }
  };
});
