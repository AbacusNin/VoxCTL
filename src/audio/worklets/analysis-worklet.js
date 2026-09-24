// Collects microphone samples on the audio thread and posts one analysis
// window per hop to the main thread. No analysis runs here: this thread also
// renders the synth, and v0.3's pitch search inside process() took up to 71%
// of the 2.67 ms render quantum at 48 kHz and overran it at 96 kHz.
class VoiceAnalyzerProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions = {} } = {}) {
    super();
    this.size = processorOptions.windowSize || 2048;
    this.hop = processorOptions.hopSize || 1408;
    this.ring = new Float32Array(this.size);
    this.writeIndex = 0;
    this.samplesSeen = 0;
    this.sinceLastPost = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    outputs[0]?.[0]?.fill(0);
    if (!input?.length) return true;

    for (let i = 0; i < input.length; i++) {
      this.ring[this.writeIndex] = input[i];
      this.writeIndex = (this.writeIndex + 1) % this.size;
    }
    this.samplesSeen += input.length;
    this.sinceLastPost += input.length;

    if (this.sinceLastPost >= this.hop && this.samplesSeen >= this.size) {
      this.sinceLastPost = 0;
      // Unroll the ring oldest-first; transferring the copy avoids a clone.
      const window = new Float32Array(this.size);
      window.set(this.ring.subarray(this.writeIndex), 0);
      window.set(this.ring.subarray(0, this.writeIndex), this.size - this.writeIndex);
      this.port.postMessage({ type: 'window', samples: window }, [window.buffer]);
    }
    return true;
  }
}

registerProcessor('voice-analyzer-processor', VoiceAnalyzerProcessor);
