import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi } from './api.js';
import { localSpeech } from './local-speech.js';

const app = new Hono();
app.route('/api', createApi({ localSpeech }));
app.use('*', serveStatic({ root: './dist/client' }));
const port = Number(process.env.PORT || 3000);
const hostname = '127.0.0.1';

serve({
  hostname,
  port,
  fetch: (request) => app.fetch(request, process.env),
}, ({ port: actualPort }) => {
  console.log(`Голосовой помощник: http://${hostname}:${actualPort}`);
});
