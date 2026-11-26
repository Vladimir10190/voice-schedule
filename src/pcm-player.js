const bufferDuration = 0.18;

export function createPcmPlayer(context, onPlayback) {
  const nodes = new Set();
  let buffered = [];
  let secondsBuffered = 0;
  let started = false;
  let stopped = false;
  let nextStart = 0;
  let completed;

  function flush() {
    if (!buffered.length || stopped) return;
    if (!started) {
      started = true;
      onPlayback();
    }
    nextStart = Math.max(nextStart, context.currentTime + (nextStart > context.currentTime ? 0 : 0.035));
    for (const audio of buffered) {
      const source = context.createBufferSource();
      source.buffer = audio;
      source.connect(context.destination);
      source.onended = () => {
        source.disconnect();
        nodes.delete(source);
        if (!nodes.size) completed?.();
      };
      nodes.add(source);
      source.start(nextStart);
      nextStart += audio.duration;
    }
    buffered = [];
    secondsBuffered = 0;
  }

  return {
    push(base64, sampleRate = 24_000) {
      if (stopped) return;
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const samples = new DataView(bytes.buffer);
      const audio = context.createBuffer(1, bytes.length / 2, sampleRate);
      const channel = audio.getChannelData(0);
      for (let index = 0; index < channel.length; index += 1) {
        channel[index] = samples.getInt16(index * 2, true) / 32768;
      }
      buffered.push(audio);
      secondsBuffered += audio.duration;
      if (started || secondsBuffered >= bufferDuration) flush();
    },
    finish() {
      flush();
      if (!nodes.size) return Promise.resolve();
      return new Promise((resolve) => { completed = resolve; });
    },
    stop() {
      stopped = true;
      buffered = [];
      for (const source of nodes) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      nodes.clear();
      completed?.();
    },
  };
}
