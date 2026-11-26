import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AudioLines, CircleAlert, LoaderCircle, MessageCircle, Mic, RotateCcw, Send, Square, Volume2,
} from 'lucide-react';
import { useVoiceSession } from './use-voice-session.js';
import './styles.css';

const phases = {
  idle: { title: 'Готов к разговору', hint: 'После запуска браузер запросит доступ к микрофону.', icon: Mic },
  connecting: { title: 'Подключаюсь', hint: 'Проверяю доступность сервера.', icon: LoaderCircle },
  requesting: { title: 'Включаю микрофон', hint: 'Разрешите запись в браузере, если он попросит.', icon: LoaderCircle },
  listening: { title: 'Слушаю вас', hint: 'Задайте вопрос и нажмите «Отправить вопрос».', icon: Mic },
  transcribing: { title: 'Распознаю речь', hint: 'Голосовой вопрос скоро появится в диалоге.', icon: LoaderCircle },
  checking: { title: 'Проверяю расписание', hint: 'Уточняю день и время из вашего вопроса.', icon: LoaderCircle },
  preparing: { title: 'Готовлю голосовой ответ', hint: 'Ответ уже доступен в диалоге.', icon: LoaderCircle },
  speaking: { title: 'Воспроизвожу ответ', hint: 'После ответа можно задать следующий вопрос.', icon: Volume2 },
  ready: { title: 'Готов слушать дальше', hint: 'Запишите новый вопрос или завершите разговор.', icon: Mic },
  ended: { title: 'Разговор завершён', hint: 'Вы можете начать новый разговор.', icon: Mic },
  error: { title: 'Возникла ошибка', icon: CircleAlert },
};

const connectionLabels = {
  disconnected: 'Нет соединения',
  connecting: 'Подключение',
  connected: 'Сервер подключён',
  unavailable: 'Сбой соединения',
};

function Microphone({ phase }) {
  const Icon = phases[phase].icon;
  return (
    <div className={`microphone-stage ${phase}`} aria-hidden="true">
      <div className="orbit">
        <span className="orbit-dot" />
        <div className="orbit-mid" />
        <div className="orbit-inner" />
        <div className="mic-icon"><Icon size={37} strokeWidth={1.65} /></div>
      </div>
    </div>
  );
}

function VoiceControls({ voice }) {
  const { phase, active, error, canRetryTurn, start, end, record, retry, send } = voice;
  const { title, hint } = phases[phase];
  return (
    <section className="panel voice-panel" aria-labelledby="voice-heading">
      <h2 className="panel-heading" id="voice-heading"><Mic size={18} /> Голосовая сессия</h2>
      <div className="voice-center">
        <Microphone phase={phase} />
        <div className="voice-status" role="status">
          <p className="phase-title">{title}</p>
          {hint && <p className="phase-hint">{hint}</p>}
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
      <div className="actions">
        {(!active || phase === 'connecting') && (
          <button className="primary" onClick={start} disabled={phase === 'connecting'}>
            {phase === 'error' ? <RotateCcw size={18} /> : <Mic size={18} />}
            {phase === 'error' ? 'Повторить подключение' : phase === 'ended' ? 'Начать новый разговор' : 'Начать разговор'}
          </button>
        )}
        {phase === 'listening' && (
          <button className="primary" onClick={send}><Send size={18} /> Отправить вопрос</button>
        )}
        {(phase === 'ready' || (phase === 'error' && active)) && (
          <button className="primary" onClick={record}><Mic size={18} /> Записать вопрос</button>
        )}
        {phase === 'error' && active && canRetryTurn && (
          <button className="secondary" onClick={retry}><RotateCcw size={16} /> Повторить обработку</button>
        )}
        {active && <button className="secondary" onClick={end}><Square size={14} /> Завершить разговор</button>}
      </div>
    </section>
  );
}

function Transcript({ messages }) {
  const log = useRef(null);
  useEffect(() => {
    log.current.scrollTop = log.current.scrollHeight;
  }, [messages]);

  return (
    <section className="panel transcript-panel" aria-labelledby="dialogue-heading">
      <h2 className="panel-heading" id="dialogue-heading"><MessageCircle size={18} /> Диалог</h2>
      <div className="transcript" ref={log} role="log" aria-labelledby="dialogue-heading">
        {!messages.length && (
          <div className="empty">
            <div className="empty-icon"><MessageCircle size={25} strokeWidth={1.5} /></div>
            <p>Здесь появится разговор</p>
            <span>Вопросы и ответы будут видны здесь в виде текста.</span>
          </div>
        )}
        {messages.map(({ id, question, answer }) => (
          <div className="exchange" key={id}>
            {question && <div className="bubble user"><span>Вы</span><p>{question}</p></div>}
            {answer && <div className="bubble assistant"><span>Помощник</span><p>{answer}</p></div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function App() {
  const voice = useVoiceSession();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap topbar-content">
          <div className="brand"><div className="brand-mark"><AudioLines size={22} /></div> Голосовой помощник</div>
          <div className={`connection ${voice.connection}`} role="status">
            <span className="connection-dot" /> {connectionLabels[voice.connection]}
          </div>
        </div>
      </header>

      <main className="wrap">
        <div className="intro">
          <h1>Учебное расписание</h1>
          <p>Задайте вопрос голосом и узнайте, когда есть свободное время.</p>
        </div>
        <div className="workspace">
          <VoiceControls voice={voice} />
          <Transcript messages={voice.messages} />
        </div>
        <section className="examples" aria-labelledby="examples-heading">
          <h2 id="examples-heading">Примеры вопросов</h2>
          <ul>
            <li>«Можно завтра после шести?»</li>
            <li>«А завтра в 19:00?»</li>
            <li>«Что есть на послезавтра?»</li>
          </ul>
        </section>
      </main>
      <footer className="wrap"><AudioLines size={16} /> Ответы озвучивает синтезированный голос</footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
