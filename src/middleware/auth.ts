import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import { HonoEnv } from '../hono';

export const protect = createMiddleware<HonoEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ message: 'Not authorized, no token' }, 401);
    }

    const token = authHeader.split(' ')[1];
    try {
        const decodedPayload: any = await verify(token, c.env.DISCORD_CLIENT_SECRET, "HS256");
        c.set('user', {
            id: decodedPayload.id,
            username: decodedPayload.username,
            avatar: decodedPayload.avatar,
            role: decodedPayload.role
        });
        await next();
    } catch (error) {
        return c.json({ message: 'Not authorized, token failed' }, 401);
    }
});

// Protect routes that write to the database based on the write token
export const protectWrite = createMiddleware<HonoEnv>(async (c, next) => {
    const writeTokenHeader = c.req.header('X-Write-Token');
    if (!writeTokenHeader) {
        return c.json({ message: 'Write permission required. No write token provided.' }, 403);
    }
    try {
        const decoded: any = await verify(writeTokenHeader, c.env.DISCORD_CLIENT_SECRET, "HS256");
        if (decoded.grant !== 'write') {
            return c.json({ message: 'Invalid write token.' }, 403);
        }
        
        // Also verify the server ID matches the one in the token if applicable
        const serverId = c.req.param('serverId');
        if (serverId && decoded.serverId !== serverId) {
            return c.json({ message: 'Write token is not valid for this server.' }, 403);
        }
        
        await next();
    } catch (error) {
        return c.json({ message: 'Invalid or expired write token.' }, 403);
    }
});