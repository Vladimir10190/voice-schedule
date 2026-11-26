import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream } from 'hono/streaming';
import { interpret, readProviders, synthesize, transcribe, VoiceError } from './providers.js';
import { createReply, knownDay } from './schedule.js';

const audioExtensions = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};
const maxUpload = 5 * 1024 * 1024;
const timeout = 70_000;

async function sendAudio({ body, sampleRate }, write, signal) {
  const reader = body.getReader();
  const buffer = new Uint8Array(6144);
  let length = 0;
  let sent = false;
  const flush = async () => {
    const bytes = buffer.subarray(0, length);
    await write({ type: 'audio', sampleRate, data: btoa(String.fromCharCode(...bytes)) });
    sent = true;
    length = 0;
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length;) {
        const toCopy = Math.min(value.length - offset, buffer.length - length);
        buffer.set(value.subarray(offset, offset + toCopy), length);
        length += toCopy;
        offset += toCopy;
        if (length === buffer.length) await flush();
      }
    }
    if (length % 2 !== 0) throw new VoiceError('Провайдер прислал неполный аудиопоток.');
    if (length > 0) await flush();
    if (!sent) throw new VoiceError('Провайдер прислал пустой аудиоответ.');
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createApi({ localSpeech } = {}) {
  const api = new Hono();
  function readConfig(env) {
    const providers = readProviders(env || {});
    if (providers.tts.kind === 'espeak' && !localSpeech) {
      throw new VoiceError('Локальная озвучка eSpeak NG доступна при запуске через Node.js.');
    }
    return providers;
  }
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method === 'POST') {
      const origin = c.req.header('Origin');
      if (origin && origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'Откройте приложение по его локальному адресу.' }, 403);
      }
    }
    await next();
  });

  api.get('/health', (c) => {
    try {
      readConfig(c.env);
      return c.json({ ready: true });
    } catch (error) {
      return c.json({ error: error instanceof VoiceError ? error.message : 'Проверьте настройки сервера.' }, 503);
    }
  });

  api.post('/turn', bodyLimit({
    maxSize: maxUpload,
    onError: (c) => c.json({ error: 'Запись слишком большая. Попробуйте задать вопрос короче.' }, 413),
  }), async (c) => {
    let providers;
    try {
      providers = readConfig(c.env);
    } catch (error) {
      return c.json({ error: error instanceof VoiceError ? error.message : 'Проверьте настройки сервера.' }, 503);
    }

    let form;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'Не удалось прочитать запись. Запишите вопрос снова.' }, 400);
    }
    const audio = form.get('audio');
    const extension = audio instanceof File && audioExtensions[audio.type.split(';')[0].toLowerCase()];
    if (!extension || !audio.size) {
      return c.json({ error: 'Не удалось получить аудио. Попробуйте записать вопрос в Chrome, Edge или Firefox.' }, 400);
    }

    const rawDay = form.get('previousDay');
    const previousDay = knownDay(rawDay) ? rawDay : null;
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('X-Accel-Buffering', 'no');

    return stream(c, async (connection) => {
      const disconnect = new AbortController();
      const deadline = AbortSignal.timeout(timeout);
      const signal = AbortSignal.any([disconnect.signal, c.req.raw.signal, deadline]);
      connection.onAbort(() => disconnect.abort());
      const write = (event) => connection.writeln(JSON.stringify(event));
      let failure = 'Не удалось распознать речь. Попробуйте повторить вопрос.';

      try {
        await write({ type: 'stage', value: 'transcribing' });
        const transcript = await transcribe(providers.stt, audio, `question.${extension}`, signal);
        await write({ type: 'transcript', text: transcript });
        await write({ type: 'stage', value: 'checking' });

        failure = 'Не удалось обработать вопрос. Попробуйте ещё раз.';
        const intent = await interpret(providers.llm, transcript, previousDay, signal);
        const reply = createReply(intent, previousDay);
        await write({ type: 'answer', text: reply.text, day: reply.day });
        await write({ type: 'stage', value: 'preparing' });

        failure = 'Воспроизведение прервалось. Попробуйте озвучить ответ ещё раз.';
        const pcm = providers.tts.kind === 'espeak'
          ? await localSpeech(providers.tts, reply.text, signal)
          : await synthesize(providers.tts, reply.text, signal);
        await sendAudio(pcm, write, signal);
        await write({ type: 'done', retry: reply.retry ? reply.text : null });
      } catch (error) {
        if (disconnect.signal.aborted || c.req.raw.signal.aborted) return;
        const message = deadline.aborted
          ? 'Провайдер не ответил вовремя. Попробуйте ещё раз.'
          : (error instanceof VoiceError ? error.message : failure);
        await write({ type: 'error', message });
      }
    });
  });

  return api;
}
