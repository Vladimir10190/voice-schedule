export class SessionError extends Error {
  constructor(message, disconnected = false) {
    super(message);
    this.disconnected = disconnected;
  }
}

async function request(path, init) {
  let response;
  try {
    response = await fetch(path, { ...init, cache: 'no-store' });
  } catch (error) {
    if (init.signal.aborted) throw error;
    throw new SessionError('Связь с локальным сервером прервалась. Проверьте, запущено ли приложение.', true);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new SessionError(body.error || 'Сервер не смог обработать запрос. Попробуйте ещё раз.', path === '/api/health');
  }
  return response;
}

export async function checkServer(signal) {
  const response = await request('/api/health', { signal });
  const result = await response.json().catch(() => ({}));
  if (!result.ready) throw new SessionError('Проверьте, запущен ли сервер приложения.', true);
}

export async function readTurn(turn, signal, onEvent) {
  const body = new FormData();
  body.set('audio', turn.audio, 'question');
  if (turn.previousDay) body.set('previousDay', turn.previousDay);
  const response = await request('/api/turn', { method: 'POST', body, signal });
  if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
    throw new SessionError('Сервер не вернул ожидаемый поток ответа.', true);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) {
          const event = JSON.parse(line);
          if (event.type === 'error') throw new SessionError(event.message);
          if (event.type === 'done') return event;
          onEvent(event);
        }
        newline = pending.indexOf('\n');
      }
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throw new SessionError('Ответ прервался. Попробуйте повторить вопрос.', true);
}
