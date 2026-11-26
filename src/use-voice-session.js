import { useEffect, useRef, useState } from 'react';
import { createPcmPlayer } from './pcm-player.js';
import { checkServer, readTurn, SessionError } from './voice-api.js';

const maxRecordingTime = 30_000;
const mimeTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function disposeRecording(recording) {
  if (!recording) return;
  clearTimeout(recording.timer);
  const { recorder, stream } = recording;
  if (recorder) {
    recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
    if (recorder.state !== 'inactive') recorder.stop();
  }
  stopTracks(stream);
}

function disposeSession(session) {
  if (!session) return;
  session.health.abort();
  session.turn?.controller.abort();
  session.turn?.player.stop();
  disposeRecording(session.recording);
  session.audioContext?.close().catch(() => {});
}

function microphoneMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Микрофон недоступен. Разрешите его использование в настройках браузера и попробуйте снова.';
  }
  if (error?.name === 'NotFoundError') return 'Микрофон не найден. Подключите его и попробуйте снова.';
  if (error?.name === 'NotReadableError') return 'Не удалось включить микрофон. Проверьте, доступен ли он в системе.';
  return 'Браузер не смог начать запись. Попробуйте ещё раз в Chrome, Edge или Firefox.';
}

export function useVoiceSession() {
  const sessionRef = useRef(null);
  const [phase, setPhase] = useState('idle');
  const [connection, setConnection] = useState('disconnected');
  const [error, setError] = useState('');
  const [canRetryTurn, setCanRetryTurn] = useState(false);
  const [messages, setMessages] = useState([]);
  const current = (session) => sessionRef.current === session;

  useEffect(() => () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    disposeSession(session);
  }, []);

  const showError = (message, retry = false) => {
    setError(message);
    setCanRetryTurn(retry);
    setPhase('error');
  };

  function end() {
    const session = sessionRef.current;
    sessionRef.current = null;
    disposeSession(session);
    setError('');
    setCanRetryTurn(false);
    setConnection('disconnected');
    setPhase('ended');
  }

  function updateMessage(id, fields) {
    setMessages((previous) => {
      if (previous.some((message) => message.id === id)) {
        return previous.map((message) => message.id === id ? { ...message, ...fields } : message);
      }
      return [...previous, { id, ...fields }];
    });
  }

  async function runTurn(session, turn) {
    if (!current(session) || session.turn) return;
    setPhase('transcribing');
    setError('');
    setCanRetryTurn(false);
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(80_000);
    const player = createPcmPlayer(session.audioContext, () => {
      if (current(session)) setPhase('speaking');
    });
    const active = { controller, player };
    session.turn = active;
    session.lastTurn = turn;
    try {
      const completion = await readTurn(turn, AbortSignal.any([controller.signal, deadline]), (event) => {
        if (!current(session)) return;
        if (event.type === 'stage') setPhase(event.value);
        if (event.type === 'transcript') updateMessage(turn.id, { question: event.text });
        if (event.type === 'answer') {
          session.previousDay = event.day;
          updateMessage(turn.id, { answer: event.text });
        }
        if (event.type === 'audio') player.push(event.data, event.sampleRate);
      });
      if (!current(session)) return;
      setConnection('connected');
      await player.finish();
      if (!current(session)) return;
      if (completion.retry) {
        showError(completion.retry, true);
      } else {
        session.lastTurn = null;
        setPhase('ready');
      }
    } catch (problem) {
      player.stop();
      if (!current(session)) return;
      if (deadline.aborted || problem.disconnected || !(problem instanceof SessionError)) {
        setConnection('unavailable');
      }
      showError(problem instanceof SessionError ? problem.message : 'Ответ прервался. Попробуйте повторить вопрос.', true);
    } finally {
      controller.abort();
      if (session.turn === active) session.turn = null;
    }
  }

  async function record() {
    const session = sessionRef.current;
    if (!session || !session.ready || session.recording || session.turn) return;
    setError('');
    setCanRetryTurn(false);
    setPhase('requesting');
    const recording = { stream: null, recorder: null, timer: null };
    session.recording = recording;
    session.lastTurn = null;
    try {
      await session.audioContext.resume();
      if (!current(session)) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!current(session)) {
        stopTracks(stream);
        return;
      }
      recording.stream = stream;
      const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recording.recorder = recorder;
      const chunks = [];
      recorder.ondataavailable = ({ data }) => {
        if (data.size) chunks.push(data);
      };
      recorder.onerror = ({ error: problem }) => {
        if (!current(session)) return;
        session.recording = null;
        disposeRecording(recording);
        showError(microphoneMessage(problem));
      };
      recorder.onstop = () => {
        if (!current(session)) return;
        session.recording = null;
        disposeRecording(recording);
        const audio = new Blob(chunks, { type: chunks[0]?.type || recorder.mimeType });
        if (!audio.size) {
          showError('Запись получилась пустой. Попробуйте задать вопрос ещё раз.');
          return;
        }
        void runTurn(session, { id: ++session.turnNumber, audio, previousDay: session.previousDay });
      };
      recorder.start();
      recording.timer = setTimeout(send, maxRecordingTime);
      setPhase('listening');
    } catch (problem) {
      disposeRecording(recording);
      if (!current(session)) return;
      session.recording = null;
      showError(microphoneMessage(problem));
    }
  }

  function send() {
    const recording = sessionRef.current?.recording;
    if (recording?.recorder?.state !== 'recording') return;
    clearTimeout(recording.timer);
    recording.recorder.stop();
    stopTracks(recording.stream);
    setPhase('transcribing');
  }

  async function start() {
    if (sessionRef.current) return;
    const session = {
      health: new AbortController(),
      audioContext: null,
      ready: false,
      turnNumber: 0,
      previousDay: null,
      turn: null,
      lastTurn: null,
      recording: null,
    };
    sessionRef.current = session;
    setMessages([]);
    setError('');
    setCanRetryTurn(false);
    setPhase('connecting');
    setConnection('connecting');

    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioContext) {
        throw new SessionError('Для записи нужен современный браузер. Откройте приложение через localhost или HTTPS.');
      }
      session.audioContext = new AudioContext();
      const deadline = AbortSignal.timeout(5000);
      await Promise.all([
        session.audioContext.resume(),
        checkServer(AbortSignal.any([session.health.signal, deadline])),
      ]);
      if (!current(session)) return;
      session.ready = true;
      setConnection('connected');
      await record();
    } catch (problem) {
      if (!current(session)) return;
      sessionRef.current = null;
      disposeSession(session);
      setConnection('unavailable');
      showError(problem instanceof SessionError ? problem.message : 'Не удалось подключиться. Проверьте, запущен ли сервер.');
    }
  }

  function retry() {
    const session = sessionRef.current;
    if (session?.lastTurn) {
      void session.audioContext.resume().catch(() => {});
      void runTurn(session, session.lastTurn);
    }
  }

  return {
    phase, connection, error, canRetryTurn, messages,
    active: sessionRef.current !== null, start, end, record, send, retry,
  };
}
