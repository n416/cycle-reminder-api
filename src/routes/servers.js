import { Hono } from 'hono';
import { protect, protectWrite } from '../middleware/auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import bcrypt from 'bcryptjs';
import channelsRouter from './channels';
import emojisRouter from './emojis';
const serversRouter = new Hono();
serversRouter.route('/:serverId/channels', channelsRouter);
serversRouter.route('/:serverId/emojis', emojisRouter);
serversRouter.get('/', protect, async (c) => {
    try {
        const userId = c.get('user').id;
        const db = drizzle(c.env.DB, { schema });
        const userDoc = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
        if (!userDoc) {
            return c.json({ message: 'User not found in database' }, 404);
        }
        const guilds = userDoc.guilds;
        const subscriptionStatus = c.get('user').role;
        if (!guilds || !Array.isArray(guilds)) {
            return c.json({ message: 'Guilds not found for user. Please try logging in again.' }, 404);
        }
        const serverIds = guilds.map((g) => g.id);
        const serverSettings = {};
        if (serverIds.length > 0) {
            const serverDocs = await db.select().from(schema.servers).where(inArray(schema.servers.id, serverIds));
            serverDocs.forEach(doc => {
                serverSettings[doc.id] = doc;
            });
        }
        // Botが参加しているサーバーを取得（REST API）
        // 開発環境のバイパスが動いている場合は、モックサーバーに参加していることにする
        let botGuildIds = new Set();
        if (c.env.NODE_ENV === 'development' && userId === '999999999999999999') {
            botGuildIds.add('dev_server_1');
        }
        else {
            const botGuildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
                headers: { Authorization: `Bot ${c.env.DISCORD_BOT_TOKEN}` }
            });
            if (botGuildsRes.ok) {
                const botGuilds = await botGuildsRes.json();
                botGuilds.forEach(g => botGuildIds.add(g.id));
            }
            else {
                console.warn('Failed to fetch bot guilds via REST API');
            }
        }
        const servers = guilds.map((guild) => {
            const permissions = BigInt(guild.permissions);
            const isDiscordAdmin = (permissions & BigInt(0x20)) === BigInt(0x20);
            let finalRole = 'member';
            const userSubStatus = userDoc?.subscriptionStatus;
            if (subscriptionStatus === 'tester' || subscriptionStatus === 'owner' || (userSubStatus === 'active' && isDiscordAdmin)) {
                finalRole = 'admin';
            }
            else if (isDiscordAdmin) {
                finalRole = 'admin';
            }
            const settings = serverSettings[guild.id] || {};
            return {
                id: guild.id,
                name: guild.name,
                icon: guild.icon,
                role: finalRole,
                isAdded: botGuildIds.has(guild.id),
                customName: settings.customName || null,
                customIcon: settings.customIcon || null,
                serverType: settings.serverType || 'normal',
            };
        });
        return c.json(servers);
    }
    catch (error) {
        console.error('Failed to fetch guilds:', error);
        return c.json({ message: 'Failed to fetch guilds' }, 500);
    }
});
serversRouter.put('/:serverId/settings', protect, protectWrite, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const { customName, customIcon, serverType } = await c.req.json();
        if (!['normal', 'hit_the_world'].includes(serverType)) {
            return c.json({ message: 'Invalid serverType.' }, 400);
        }
        const db = drizzle(c.env.DB, { schema });
        await db.insert(schema.servers).values({
            id: serverId,
            customName: customName || null,
            customIcon: customIcon || null,
            serverType: serverType
        }).onConflictDoUpdate({
            target: schema.servers.id,
            set: {
                customName: customName || null,
                customIcon: customIcon || null,
                serverType: serverType
            }
        });
        return c.json({ customName, customIcon, serverType });
    }
    catch (error) {
        return c.json({ message: 'Failed to update server settings' }, 500);
    }
});
serversRouter.put('/:serverId/password', protect, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const { password } = await c.req.json();
        const userId = c.get('user').id;
        const appRole = c.get('user').role;
        if (appRole !== 'owner' && appRole !== 'tester') {
            return c.json({ message: 'Forbidden: Only owners or testers can change server settings.' }, 403);
        }
        const db = drizzle(c.env.DB, { schema });
        const userDoc = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
        const serverInfo = userDoc?.guilds?.find((g) => g.id === serverId);
        if (!serverInfo) {
            return c.json({ message: 'Forbidden: User is not a member of this server.' }, 403);
        }
        const permissions = BigInt(serverInfo.permissions);
        const isAdmin = (permissions & BigInt(0x20)) === BigInt(0x20);
        if (!isAdmin) {
            return c.json({ message: 'Forbidden: User is not an admin of this server.' }, 403);
        }
        if (password && typeof password === 'string') {
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);
            await db.insert(schema.servers).values({ id: serverId, passwordHash }).onConflictDoUpdate({
                target: schema.servers.id,
                set: { passwordHash }
            });
            return c.json({ message: 'Password updated successfully.' });
        }
        else {
            await db.insert(schema.servers).values({ id: serverId, passwordHash: null }).onConflictDoUpdate({
                target: schema.servers.id,
                set: { passwordHash: null }
            });
            return c.json({ message: 'Password removed successfully.' });
        }
    }
    catch (error) {
        return c.json({ message: 'Failed to update password' }, 500);
    }
});
serversRouter.post('/:serverId/verify-password', protect, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const body = await c.req.json().catch(() => ({}));
        const password = body.password;
        const userId = c.get('user').id;
        const appRole = c.get('user').role;
        const db = drizzle(c.env.DB, { schema });
        const userDoc = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
        if (!userDoc)
            return c.json({ message: 'User not found.' }, 404);
        const serverInfo = userDoc.guilds?.find((g) => g.id === serverId);
        if (!serverInfo)
            return c.json({ message: 'Forbidden: You are not a member.' }, 403);
        const isDiscordAdmin = (BigInt(serverInfo.permissions) & BigInt(0x20)) === BigInt(0x20);
        const hasOwnerRights = (appRole === 'owner') && isDiscordAdmin;
        const isAppTester = appRole === 'tester';
        if (hasOwnerRights || isAppTester) {
            const writeToken = await sign({ userId, serverId, grant: 'write', exp: Math.floor(Date.now() / 1000) + 86400 }, c.env.DISCORD_CLIENT_SECRET);
            return c.json({ writeToken });
        }
        const serverData = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
        if (!serverData || !serverData.passwordHash) {
            const writeToken = await sign({ userId, serverId, grant: 'write', exp: Math.floor(Date.now() / 1000) + 86400 }, c.env.DISCORD_CLIENT_SECRET);
            return c.json({ writeToken });
        }
        if (typeof password !== 'string' || !password) {
            return c.json({ message: 'Password is required.' }, 400);
        }
        const isValid = await bcrypt.compare(password, serverData.passwordHash);
        if (!isValid) {
            return c.json({ message: 'Invalid password.' }, 403);
        }
        const writeToken = await sign({ userId, serverId, grant: 'write', exp: Math.floor(Date.now() / 1000) + 86400 }, c.env.DISCORD_CLIENT_SECRET);
        return c.json({ writeToken });
    }
    catch (error) {
        return c.json({ message: 'Failed to verify password' }, 500);
    }
});
serversRouter.get('/:serverId/password-status', protect, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const db = drizzle(c.env.DB, { schema });
        const serverDoc = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
        if (serverDoc && serverDoc.passwordHash) {
            return c.json({ hasPassword: true });
        }
        else {
            return c.json({ hasPassword: false });
        }
    }
    catch (error) {
        return c.json({ message: 'Failed to check password status.' }, 500);
    }
});
export default serversRouter;
