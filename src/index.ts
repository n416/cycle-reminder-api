import express, { Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import authRouter from './routes/auth';
import remindersRouter from './routes/reminders';
import serversRouter from './routes/servers';
import logsRouter from './routes/logs';
import { checkAndSendReminders } from './scheduler';
import paymentRouter from './routes/payment';
import missedNotificationsRouter from './routes/missedNotifications';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;


const allowedOrigins = [
  'http://localhost:5173',
];
if (process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL_PROD) {
  allowedOrigins.push(process.env.FRONTEND_URL_PROD);
}

const corsOptions: CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));


app.use(express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => { // ★ 修正点: 'res' を '_res' に変更
        if (req.originalUrl.startsWith('/api/payment/webhook')) {
            req.rawBody = buf;
        }
    }
}));


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

const main = async () => {
  try {
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
    app.use('/api/payment', paymentRouter);
    app.use('/api/missed-notifications', missedNotificationsRouter);
    
    await client.login(process.env.DISCORD_BOT_TOKEN);
    console.log(`Bot logged in as ${client.user?.tag}!`);

    app.listen(PORT, () => {
      console.log(`API Server is running on port ${PORT}`);
    });

    startScheduler();

  } catch (error) {
    console.error("Failed to start the application:", error);
    process.exit(1);
  }
};

main();