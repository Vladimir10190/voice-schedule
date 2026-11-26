const schedule = Object.freeze({
  tomorrow: Object.freeze({
    '18:30': 'free',
    '19:00': 'busy',
  }),
  day_after: null,
});

const dayNames = { tomorrow: 'На завтра', day_after: 'На послезавтра' };

export function knownDay(day) {
  return day === 'tomorrow' || day === 'day_after';
}

export function lookupSchedule(day) {
  return schedule[day];
}

function matches(time, filter) {
  switch (filter.mode) {
    case 'exact': return time === filter.time;
    case 'after': return time > filter.time;
    case 'before': return time < filter.time;
    case 'from': return time >= filter.time;
    case 'until': return time <= filter.time;
    case 'between': return time >= filter.time && time <= filter.end;
    default: return true;
  }
}

export function createReply(intent, previousDay, lookup = lookupSchedule) {
  const day = intent.day === 'same' ? previousDay : intent.day;
  const prefix = intent.kind === 'booking' ? 'Я могу только проверить расписание. ' : '';
  const reply = (text, nextDay = null, retry = false) => ({ text: prefix + text, day: nextDay, retry });

  if (intent.kind === 'other') {
    return reply('Я могу подсказать свободное время. Спросите, например, есть ли что-нибудь завтра после шести.', previousDay);
  }
  if (!day || day === 'missing') {
    return reply('На какой день проверить расписание? Можно спросить про завтра или послезавтра.');
  }
  if (!knownDay(day)) {
    return reply('На этот день у меня нет данных. Могу проверить завтра или послезавтра.');
  }

  let slots;
  try {
    const result = lookup(day);
    if (result === null) return reply(`${dayNames[day]} в расписании пока нет данных.`, day);
    slots = Object.entries(result);
    if (slots.some(([time, status]) => !validTime(time) || !['free', 'busy'].includes(status))) {
      throw new Error('Invalid schedule');
    }
  } catch {
    return reply('При проверке расписания произошла ошибка. Попробуйте ещё раз.', previousDay, true);
  }

  const matchingSlots = slots
    .filter(([time]) => matches(time, intent.filter))
    .sort(([left], [right]) => left.localeCompare(right));
  if (!matchingSlots.length) {
    return reply(`${dayNames[day]} в расписании нет данных на указанное время.`, day);
  }

  const free = matchingSlots.filter(([, status]) => status === 'free').map(([time]) => time);
  const busy = matchingSlots.filter(([, status]) => status === 'busy').map(([time]) => time);
  const lines = [];
  if (free.length) lines.push(`${dayNames[day]} свободно ${free.join(', ')}.`);
  if (busy.length === 1) lines.push(`В ${busy[0]} время занято.`);
  if (busy.length > 1) lines.push(`Занятые часы — ${busy.join(', ')}.`);
  if (free.length === 1 && intent.filter.mode !== 'exact' && intent.kind === 'check') {
    lines.push(`Вам подходит ${free[0]}?`);
  }
  return reply(lines.join(' '), day);
}

export function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
