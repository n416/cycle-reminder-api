import { D1Database } from '@cloudflare/workers-types';

export type Bindings = {
  DB: D1Database;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_REDIRECT_URI: string;
  FRONTEND_URL: string;
  DISCORD_BOT_TOKEN: string;
  TESTER_PASSWORD?: string;
  NODE_ENV?: string;
  KOMOJU_SECRET_KEY: string;
  KOMOJU_WEBHOOK_SECRET: string;
};

export type Variables = {
  user: {
    id: string;
    username: string;
    avatar?: string;
    role: 'owner' | 'tester' | 'supporter' | 'admin' | 'member';
  };
};

export type HonoEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
