import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../server/api.js';
import { localSpeech } from '../server/local-speech.js';
import { readProviders, transcribe } from '../server/providers.js';
import { createReply } from '../server/schedule.js';
import { createPcmPlayer } from '../src/pcm-player.js';

const intent = {
  kind: 'check',
  day: 'tomorrow',
  filter: { mode: 'after', time: '18:00', end: null },
};

test('расписание определяет ответ, включая уточнение времени и просьбу о записи', () => {
  assert.equal(
    createReply(intent, null).text,
    'На завтра свободно 18:30. В 19:00 время занято. Вам подходит 18:30?',
  );
  const exact = { mode: 'exact', time: '19:00', end: null };
  assert.equal(createReply({ ...intent, day: 'same', filter: exact }, 'tomorrow').text, 'В 19:00 время занято.');
  assert.match(createReply({ ...intent, kind: 'booking' }, null).text, /^Я могу только проверить расписание\./);
  assert.match(createReply({ ...intent, day: 'same' }, null).text, /^На какой день/);
});

test('отсутствие данных и ошибка проверки дают разные ответы', () => {
  const missingDay = createReply({ ...intent, day: 'day_after' }, 'tomorrow');
  assert.equal(missingDay.text, 'На послезавтра в расписании пока нет данных.');
  assert.equal(missingDay.retry, false);
  const unknownTime = createReply({ ...intent, filter: { mode: 'exact', time: '20:00', end: null } }, null);
  assert.match(unknownTime.text, /нет данных на указанное время/);
  const failure = createReply(intent, null, () => { throw new Error('fixture'); });
  assert.match(failure.text, /произошла ошибка/);
  assert.equal(failure.retry, true);
});

test('API возвращает аудио до закрытия потока TTS', { timeout: 5000 }, async (context) => {
  const env = {
    LLM_BASE_URL: 'http://127.0.0.1:9999/v1',
    LLM_MODEL: 'fixture-llm',
    STT_MODEL: 'fixture-stt',
    TTS_MODEL: 'fixture-tts',
    TTS_VOICE: 'fixture-voice',
  };
  const calls = [];
  let pcm;
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/v1/audio/transcriptions') {
      assert.equal(request.body.get('model'), env.STT_MODEL);
      assert.equal(request.body.get('file').name, 'question.webm');
      return Response.json({ text: 'Можно завтра после шести?' });
    }
    if (path === '/v1/chat/completions') {
      const { model, messages } = JSON.parse(request.body);
      assert.equal(model, env.LLM_MODEL);
      assert.equal(JSON.parse(messages.at(-1).content).previousDay, 'tomorrow');
      return Response.json({ choices: [{ message: { content: JSON.stringify(intent) } }] });
    }
    const { input, response_format: format } = JSON.parse(request.body);
    assert.match(input, /18:30.*19:00/);
    assert.equal(format, 'pcm');
    return new Response(new ReadableStream({ start(controller) {
      pcm = controller;
      pcm.enqueue(new Uint8Array(6144));
    } }), { headers: { 'Content-Type': 'audio/pcm' } });
  });

  const form = new FormData();
  form.set('audio', new Blob(['fixture'], { type: 'audio/webm;codecs=opus' }), 'question');
  form.set('previousDay', 'tomorrow');
  const api = createApi();
  const response = await api.request('/turn', { method: 'POST', body: form }, env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events = [];
  let pending = '';
  let closed = false;
  while (!closed) {
    const { done, value } = await reader.read();
    assert.equal(done, false);
    pending += value;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const event = JSON.parse(line);
      events.push(event.type);
      if (event.type === 'audio') pcm.close();
      if (event.type === 'done') closed = true;
    }
  }
  assert.deepEqual(calls, ['/v1/audio/transcriptions', '/v1/chat/completions', '/v1/audio/speech']);
  assert.deepEqual(events, ['stage', 'transcript', 'stage', 'answer', 'stage', 'audio', 'done']);
  await reader.cancel();
});

test('остановка проигрывателя отменяет поставленные в очередь фрагменты', async () => {
  let played = 0;
  let stopped = 0;
  let started = false;
  const context = {
    currentTime: 10,
    destination: {},
    createBuffer: (_, length, sampleRate) => ({
      duration: length / sampleRate, getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({
      connect() {}, disconnect() {},
      start() { played += 1; },
      stop() { stopped += 1; },
    }),
  };
  const player = createPcmPlayer(context, () => { started = true; });
  const chunk = Buffer.alloc(6144).toString('base64');
  player.push(chunk);
  assert.equal(started, false);
  player.push(chunk);
  assert.equal(started, true);
  const finished = player.finish();
  player.stop();
  player.push(chunk);
  await finished;
  assert.equal(played, 2);
  assert.equal(stopped, 2);
});

test('режим chat_audio передаёт браузерную запись в chat completions', async (context) => {
  const { stt } = readProviders({
    LLM_BASE_URL: 'http://127.0.0.1:9999/v1',
    LLM_MODEL: 'fixture-llm',
    STT_MODEL: 'fixture-stt',
    TRANSCRIPTION_MODE: 'chat_audio',
    TTS_PROVIDER: 'espeak',
  });
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(new URL(url).pathname, '/v1/chat/completions');
    const { model, messages } = JSON.parse(request.body);
    assert.equal(model, stt.model);
    assert.deepEqual(messages[0].content[1], {
      type: 'input_audio', input_audio: { data: 'AQID', format: 'webm' },
    });
    return Response.json({ choices: [{ message: { content: '  Можно завтра?  ' } }] });
  });
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
  assert.equal(await transcribe(stt, audio, 'question.webm', new AbortController().signal), 'Можно завтра?');
});

test('eSpeak генерирует PCM с частотой 22,05 кГц и завершает поток', async () => {
  const { body, sampleRate } = await localSpeech(
    { voice: 'ru' }, 'На завтра свободно. Вам подходит?', new AbortController().signal,
  );
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  assert.equal(sampleRate, 22_050);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.some((chunk) => chunk.some((byte) => byte !== 0)));
});
