import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import authRouter from './routes/auth';
import remindersRouter from './routes/reminders';
import serversRouter from './routes/servers';
import logsRouter from './routes/logs';
import { checkAndSendReminders } from './scheduler';
import missedNotificationsRouter from './routes/missedNotifications';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

export const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const SCHEDULER_INTERVAL = 60 * 1000;

const runScheduler = () => {
  checkAndSendReminders()
    .catch(console.error)
    .finally(() => {
      setTimeout(runScheduler, SCHEDULER_INTERVAL);
    });
};

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user?.tag}!`);
  console.log('[Scheduler] Starting scheduler...');
  runScheduler();
});

client.login(process.env.DISCORD_BOT_TOKEN);

app.use(cors());
app.use(express.json());

app.use('/api', (_req: Request, _res: Response, next: NextFunction) => {
  next();
});

app.get('/', (_req: Request, res: Response) => {
  res.send('Cycle Reminder API is running!');
});

app.use('/api/auth', authRouter);
app.use('/api/reminders', remindersRouter);
app.use('/api/servers', serversRouter);
app.use('/api/logs', logsRouter);
app.use('/api/missed-notifications', missedNotificationsRouter);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});