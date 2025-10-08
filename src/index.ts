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

const SCHEDULER_INTERVAL = 60 * 1000; // 1分

// --- ★★★ ここからスケジューラーの起動ロジックを修正 ★★★ ---
const startScheduler = () => {
  const now = new Date();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();
  
  // 次の分の00秒までの残り時間を計算
  const delay = (60 - seconds) * 1000 - milliseconds;

  console.log(`[Scheduler] Starting scheduler. First check will run in ${delay / 1000} seconds.`);

  setTimeout(() => {
    // 最初のチェックを実行
    checkAndSendReminders().catch(console.error);
    
    // その後は正確に1分ごとに実行
    setInterval(() => {
      checkAndSendReminders().catch(console.error);
    }, SCHEDULER_INTERVAL);
  }, delay);
};

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user?.tag}!`);
  startScheduler(); // 修正した起動関数を呼び出す
});
// --- ★★★ ここまで修正 ★★★ ---

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