import { Hono } from 'hono';
import { HonoEnv } from '../hono';
import { protect } from '../middleware/auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';

const emojisRouter = new Hono<HonoEnv>();

const CACHE_DURATION = 10 * 60 * 1000;

emojisRouter.get('/', protect, async (c) => {
    try {
        const serverId = c.req.param('serverId') as string;
        const forceRefresh = c.req.query('force-refresh') === 'true';
        
        const db = drizzle(c.env.DB, { schema });
        const serverDoc = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();

        if (!forceRefresh && serverDoc && serverDoc.emojis && serverDoc.emojisFetchedAt) {
            const lastFetched = serverDoc.emojisFetchedAt;
            if (Date.now() - lastFetched < CACHE_DURATION) {
                return c.json(serverDoc.emojis);
            }
        }

        const isDev = c.env.NODE_ENV === 'development' || c.env.FRONTEND_URL?.includes('localhost') || c.env.FRONTEND_URL?.includes('127.0.0.1');
        if (isDev && serverId === 'dev_server_1') {
            return c.json([{ id: 'dev_emoji_1', name: 'dev_emoji', url: '', animated: false }]);
        }

        const res = await fetch(`https://discord.com/api/v10/guilds/${serverId}/emojis`, {
            headers: { Authorization: `Bot ${c.env.DISCORD_BOT_TOKEN}` }
        });

        if (!res.ok) {
            if (res.status === 404 || res.status === 403) {
                 return c.json({ message: "Bot is not a member of this server." }, 404);
            }
            throw new Error(`Discord API error: ${res.status} ${res.statusText}`);
        }

        const emojisData: any[] = await res.json();
        
        const emojis = emojisData.map(emoji => ({
            id: emoji.id,
            name: emoji.name,
            url: `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`,
            animated: emoji.animated,
        }));

        await db.insert(schema.servers).values({
            id: serverId,
            emojis: emojis as any,
            emojisFetchedAt: Date.now()
        }).onConflictDoUpdate({
            target: schema.servers.id,
            set: { emojis: emojis as any, emojisFetchedAt: Date.now() }
        });

        return c.json(emojis);

    } catch (error: any) {
        console.error('Failed to fetch emojis:', error);
        return c.json({ message: 'Failed to fetch emojis' }, 500);
    }
});

export default emojisRouter;