import { Hono } from 'hono';
import { protect } from '../middleware/auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
const channelsRouter = new Hono();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
channelsRouter.get('/', protect, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const forceRefresh = c.req.query('force-refresh') === 'true';
        const db = drizzle(c.env.DB, { schema });
        const serverDoc = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
        if (!forceRefresh && serverDoc && serverDoc.channels && serverDoc.channelsFetchedAt) {
            const lastFetched = serverDoc.channelsFetchedAt;
            if (Date.now() - lastFetched < CACHE_DURATION) {
                return c.json(serverDoc.channels);
            }
        }
        const isDev = c.env.NODE_ENV === 'development' || c.env.FRONTEND_URL?.includes('localhost') || c.env.FRONTEND_URL?.includes('127.0.0.1');
        if (isDev && serverId === 'dev_server_1') {
            return c.json([{ id: 'dev_channel_1', name: '#general' }, { id: 'dev_channel_2', name: '#test' }]);
        }
        // Fetch from Discord REST API
        // 0 = GuildText
        const res = await fetch(`https://discord.com/api/v10/guilds/${serverId}/channels`, {
            headers: { Authorization: `Bot ${c.env.DISCORD_BOT_TOKEN}` }
        });
        if (!res.ok) {
            if (res.status === 404 || res.status === 403) {
                return c.json({ message: "Bot is not a member of this server." }, 404);
            }
            throw new Error(`Discord API error: ${res.status} ${res.statusText}`);
        }
        const channels = await res.json();
        const textChannels = channels
            .filter(channel => channel.type === 0)
            .map(channel => ({ id: channel.id, name: `#${channel.name}` }))
            .sort((a, b) => a.name.localeCompare(b.name));
        await db.insert(schema.servers).values({
            id: serverId,
            channels: textChannels,
            channelsFetchedAt: Date.now()
        }).onConflictDoUpdate({
            target: schema.servers.id,
            set: { channels: textChannels, channelsFetchedAt: Date.now() }
        });
        return c.json(textChannels);
    }
    catch (error) {
        console.error('Failed to fetch channels:', error);
        return c.json({ message: 'Failed to fetch channels' }, 500);
    }
});
export default channelsRouter;
