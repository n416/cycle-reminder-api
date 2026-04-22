import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/d1';
import { HonoEnv } from './hono';
import * as schema from './db/schema';
import authRouter from './routes/auth';
import remindersRouter from './routes/reminders';
import serversRouter from './routes/servers';
import logsRouter from './routes/logs';
import missedNotificationsRouter from './routes/missedNotifications';
import paymentRouter from './routes/payment';
import { checkAndSendReminders } from './cron';

const app = new Hono<HonoEnv>();

// CORS config
app.use('*', async (c, next) => {
  const allowedOrigins = [
    'http://localhost:5173',
  ];
  if (c.env.FRONTEND_URL) {
    allowedOrigins.push(c.env.FRONTEND_URL);
  }
  const corsMiddleware = cors({
    origin: allowedOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Write-Token', 'x-write-token'],
  });
  return corsMiddleware(c, next);
});

app.get('/', (c) => c.text('Cycle Reminder API is running on Cloudflare Workers!'));

app.get('/api/time-check', (c) => {
  const serverTime = new Date();
  return c.json({
    iso: serverTime.toISOString(),
    locale: serverTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    message: "This is the current time on the edge server.",
  });
});

app.route('/api/auth', authRouter);
app.route('/api/servers', serversRouter);
app.route('/api/reminders', remindersRouter);
app.route('/api/logs', logsRouter);
app.route('/api/missed-notifications', missedNotificationsRouter);
app.route('/api/payment', paymentRouter);

export default {
  fetch: app.fetch,
  
  // Cron Trigger Entrypoint
  async scheduled(event: ScheduledEvent, env: HonoEnv['Bindings'], ctx: ExecutionContext) {
    const db = drizzle(env.DB, { schema });
    ctx.waitUntil(checkAndSendReminders(env, db));
  }
};