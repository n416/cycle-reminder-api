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

export const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildEmojisAndStickers 
  ] 
});

const SCHEDULER_INTERVAL = 60 * 1000;

const startScheduler = () => {
  const now = new Date();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();
  
  const delay = (60 - seconds) * 1000 - milliseconds;

  console.log(`[Scheduler] Starting scheduler. First check will run in ${delay / 1000} seconds.`);

  setTimeout(() => {
    checkAndSendReminders().catch(console.error);
    
    setInterval(() => {
      checkAndSendReminders().catch(console.error);
    }, SCHEDULER_INTERVAL);
  }, delay);
};

// --- ★★★ ここから起動ロジックを全面的に修正 ★★★ ---
const main = async () => {
  try {
    // 1. Expressアプリの基本設定を行う
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
    
    // 2. Discord Botがログインし、準備が完了するのを「待つ」
    await client.login(process.env.DISCORD_BOT_TOKEN);
    console.log(`Bot logged in as ${client.user?.tag}!`);

    // 3. Botの準備が完了してから、初めてAPIサーバーのリクエスト受付を開始する
    app.listen(PORT, () => {
      console.log(`API Server is running on port ${PORT}`);
    });

    // 4. 最後にスケジューラーを起動する
    startScheduler();

  } catch (error) {
    console.error("Failed to start the application:", error);
    process.exit(1);
  }
};

main();
// --- ★★★ ここまで修正 ★★★ ---