import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { sign, verify } from 'hono/jwt';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
const authRouter = new Hono();
const hasActiveSubscription = (userData) => {
    if (!userData)
        return false;
    if (userData.subscriptionStatus !== 'active')
        return false;
    if (userData.expiresAt) {
        if (new Date(userData.expiresAt) < new Date())
            return false;
    }
    return true;
};
// --- DEV AUTH BYPASS (開発環境専用ログイン) ---
authRouter.post('/dev-login', async (c) => {
    // ローカル開発環境以外からのアクセスはブロック
    const isDev = c.env.NODE_ENV === 'development' ||
        c.env.FRONTEND_URL?.includes('localhost') ||
        c.env.FRONTEND_URL?.includes('127.0.0.1');
    if (!isDev) {
        return c.json({ error: 'This endpoint is only available in development mode.' }, 403);
    }
    const db = drizzle(c.env.DB, { schema });
    const mockUserId = '999999999999999999';
    // モックのギルドデータ（Devサーバーを想定）
    const mockGuilds = [
        { id: 'dev_server_1', name: 'Dev Server 1', icon: null, permissions: '2147483647' } // 管理者権限
    ];
    await db.insert(schema.users).values({
        id: mockUserId,
        username: 'DevUser',
        avatar: null,
        accessToken: 'mock_access_token',
        refreshToken: 'mock_refresh_token',
        guilds: mockGuilds,
        subscriptionStatus: 'active', // オーナー権限にするため
    }).onConflictDoUpdate({
        target: schema.users.id,
        set: { guilds: mockGuilds, subscriptionStatus: 'active' }
    });
    // モックのサーバー設定も追加しておく（チャンネルの表示テスト用）
    await db.insert(schema.servers).values({
        id: 'dev_server_1',
        channels: [{ id: 'dev_channel_1', name: '#general' }],
        channelsFetchedAt: Date.now(),
        serverType: 'normal'
    }).onConflictDoNothing();
    const appToken = await sign({
        id: mockUserId,
        username: 'DevUser',
        avatar: null,
        role: 'owner', // 開発時は無条件でオーナー権限
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 // 7 days
    }, c.env.DISCORD_CLIENT_SECRET);
    return c.json({ token: appToken, role: 'owner' });
});
authRouter.post('/verify-tester', async (c) => {
    const { password } = await c.req.json();
    if (!c.env.TESTER_PASSWORD || password !== c.env.TESTER_PASSWORD) {
        return c.json({ message: 'Invalid tester password.' }, 401);
    }
    return c.json({ message: 'Tester password verified.' }, 200);
});
authRouter.get('/discord', (c) => {
    const role = c.req.query('role');
    const redirectPath = c.req.query('redirectPath');
    if (role !== 'owner' && role !== 'supporter' && role !== 'tester') {
        return c.text('Invalid role specified.', 400);
    }
    // btoa is available in workers
    const stateObj = JSON.stringify({ role, redirectPath });
    const state = btoa(encodeURIComponent(stateObj));
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${c.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(c.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds&state=${state}`;
    return c.redirect(discordAuthUrl);
});
authRouter.get('/discord/callback', async (c) => {
    const code = c.req.query('code');
    const error = c.req.query('error');
    const state = c.req.query('state');
    const frontendLoginUrl = `${c.env.FRONTEND_URL}/login`;
    if (error === 'access_denied' || !code || !state) {
        return c.redirect(frontendLoginUrl);
    }
    let roleIntent;
    let redirectPath;
    try {
        const decodedState = JSON.parse(decodeURIComponent(atob(state)));
        roleIntent = decodedState.role;
        redirectPath = decodedState.redirectPath;
    }
    catch (e) {
        return c.redirect(`${frontendLoginUrl}?error=invalid_state`);
    }
    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: c.env.DISCORD_CLIENT_ID,
                client_secret: c.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: c.env.DISCORD_REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (!tokenResponse.ok)
            throw new Error('Failed to get token');
        const tokenData = await tokenResponse.json();
        const { access_token, refresh_token } = tokenData;
        const [userResponse, guildsResponse] = await Promise.all([
            fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } }),
            fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${access_token}` } })
        ]);
        const user = await userResponse.json();
        const guilds = await guildsResponse.json();
        const db = drizzle(c.env.DB, { schema });
        const existingUser = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
        await db.insert(schema.users).values({
            id: user.id, username: user.username, avatar: user.avatar,
            accessToken: access_token, refreshToken: refresh_token, guilds: guilds,
        }).onConflictDoUpdate({
            target: schema.users.id,
            set: { username: user.username, avatar: user.avatar, accessToken: access_token, refreshToken: refresh_token, guilds: guilds }
        });
        let sessionRole;
        if (roleIntent === 'owner') {
            if (existingUser && hasActiveSubscription(existingUser)) {
                sessionRole = 'owner';
            }
            else {
                sessionRole = 'supporter';
            }
        }
        else {
            sessionRole = roleIntent;
        }
        const appToken = await sign({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            role: sessionRole,
            exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
        }, c.env.DISCORD_CLIENT_SECRET);
        const finalRedirectPath = redirectPath || '/servers';
        return c.redirect(`${c.env.FRONTEND_URL}/auth/callback?token=${appToken}&role_intent=${roleIntent}&redirectPath=${encodeURIComponent(finalRedirectPath)}`);
    }
    catch (e) {
        console.error("【バックエンド】Discord認証コールバックでエラー:", e);
        return c.redirect(`${frontendLoginUrl}?error=authentication_failed`);
    }
});
authRouter.get('/status', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ role: 'supporter' }, 401);
    }
    const token = authHeader.split(' ')[1];
    try {
        const decodedPayload = await verify(token, c.env.DISCORD_CLIENT_SECRET, "HS256");
        const userId = decodedPayload.id;
        const tokenRole = decodedPayload.role;
        if (tokenRole === 'tester' || tokenRole === 'supporter') {
            return c.json({ role: tokenRole });
        }
        if (tokenRole === 'owner') {
            const db = drizzle(c.env.DB, { schema });
            const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
            if (user && hasActiveSubscription(user)) {
                return c.json({ role: 'owner' });
            }
            else {
                return c.json({ role: 'supporter' });
            }
        }
        return c.json({ role: 'supporter' });
    }
    catch (e) {
        return c.json({ role: 'supporter' }, 401);
    }
});
export default authRouter;
