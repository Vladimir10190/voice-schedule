import { VoiceError } from './providers.js';

const sentences = new Intl.Segmenter('ru', { granularity: 'sentence' });
let engine;

function getEngine() {
  engine ??= import('@echogarden/espeak-ng-emscripten')
    .then(({ default: init }) => init())
    .then(({ eSpeakNGWorker }) => new eSpeakNGWorker())
    .catch(() => {
      engine = undefined;
      throw new VoiceError('Не удалось запустить eSpeak NG. Переустановите зависимости командой npm ci.');
    });
  return engine;
}

export async function localSpeech({ voice }, text, signal) {
  const worker = await getEngine();
  const parts = sentences.segment(text)[Symbol.iterator]();
  const body = new ReadableStream({
    pull(controller) {
      signal.throwIfAborted();
      const { value, done } = parts.next();
      if (done) {
        controller.close();
        return;
      }
      worker.set_voice(voice);
      worker.synthesize(value.segment.trim(), (samples) => {
        if (!samples?.length) return;
        const bytes = new Uint8Array(samples.length * 2);
        const pcm = new DataView(bytes.buffer);
        for (let index = 0; index < samples.length; index += 1) {
          pcm.setInt16(index * 2, samples[index], true);
        }
        controller.enqueue(bytes);
      });
    },
  }, { highWaterMark: 0 });
  return { body, sampleRate: 22_050 };
}
