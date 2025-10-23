import { Router, Request, Response } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';

dotenv.config();
const router = Router();

const TESTER_PASSWORD = process.env.TESTER_PASSWORD;
if (!TESTER_PASSWORD) {
    console.warn("Warning: TESTER_PASSWORD is not set. Tester login will be disabled.");
}

router.post('/verify-tester', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!TESTER_PASSWORD || password !== TESTER_PASSWORD) {
        return res.status(401).json({ message: 'Invalid tester password.' });
    }
    res.status(200).json({ message: 'Tester password verified.' });
});

// ★★★★★ ここからが修正箇所です ★★★★★
router.get('/discord', (req: Request, res: Response) => {
    const { role, redirectPath } = req.query; // redirectPathを受け取る
    if (role !== 'owner' && role !== 'supporter' && role !== 'tester') {
        return res.status(400).send('Invalid role specified.');
    }
    // stateにroleとredirectPathの両方を含める
    const state = Buffer.from(JSON.stringify({ role, redirectPath })).toString('base64');
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI!)}&response_type=code&scope=identify%20guilds&state=${state}`;
    res.redirect(discordAuthUrl);
});

router.get('/discord/callback', async (req: Request, res: Response) => {
    const { code, error, state } = req.query;
    const frontendLoginUrl = `${process.env.FRONTEND_URL}/login`;

    if (error === 'access_denied' || !code || !state) {
        return res.redirect(frontendLoginUrl);
    }

    let roleIntent: 'owner' | 'supporter' | 'tester';
    let redirectPath: string | undefined;
    try {
        // stateからroleとredirectPathの両方を取り出す
        const decodedState = JSON.parse(Buffer.from(state as string, 'base64').toString('utf-8'));
        roleIntent = decodedState.role;
        redirectPath = decodedState.redirectPath;
    } catch (e) {
        return res.redirect(`${frontendLoginUrl}?error=invalid_state`);
    }

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID!,
            client_secret: process.env.DISCORD_CLIENT_SECRET!,
            grant_type: 'authorization_code',
            code: code as string,
            redirect_uri: process.env.DISCORD_REDIRECT_URI!,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const { access_token, refresh_token } = tokenResponse.data;
        const [userResponse, guildsResponse] = await Promise.all([
            axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } }),
            axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${access_token}` } })
        ]);

        const user = userResponse.data;
        const guilds = guildsResponse.data;
        const userRef = db.collection('users').doc(user.id);

        await userRef.set({
            id: user.id, username: user.username, avatar: user.avatar,
            accessToken: access_token, refreshToken: refresh_token, guilds: guilds,
        }, { merge: true });

        let sessionRole: 'owner' | 'tester' | 'supporter';
        sessionRole = roleIntent;

        if (roleIntent === 'owner') {
            const userDoc = await userRef.get();
            const userData = userDoc.exists ? userDoc.data() : null;
            const isPaidUser = userData?.subscriptionStatus === 'active' && (!userData?.expiresAt || new Date(userData.expiresAt) >= new Date());

            if (!isPaidUser) {
                return res.redirect(`${frontendLoginUrl}?error=no_permission_for_owner`);
            }
        }

        const appToken = jwt.sign(
            {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                role: sessionRole
            },
            process.env.DISCORD_CLIENT_SECRET!,
            { expiresIn: '7d' }
        );

        // フロントエンドへのリダイレクト時に、redirectPathもクエリパラメータとして渡す
        const finalRedirectPath = redirectPath || '/servers';
        res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${appToken}&role_intent=${roleIntent}&redirectPath=${encodeURIComponent(finalRedirectPath)}`);

    } catch (e: any) {
        console.error("【バックエンド】Discord認証コールバックでエラー:", e.response?.data || e.message);
        res.redirect(`${frontendLoginUrl}?error=authentication_failed`);
    }
});
// ★★★★★ ここまで ★★★★★

router.get('/status', protect, async (req: AuthRequest, res: Response) => {
    // --- ★★★ ここからデバッグログを追加 ★★★ ---
    console.log("[AUTH DEBUG] /status endpoint hit.");
    try {
        const userId = req.user.id;
        const tokenRole = req.user.role;
        console.log(`[AUTH DEBUG] Token received for user: ${userId}, with role: ${tokenRole}`);

        if (!userId) {
            console.log("[AUTH DEBUG] No user ID found in token. Responding with 'supporter'.");
            return res.status(401).json({ role: 'supporter' }); // 認証情報がないので401を返すのが適切
        }

        if (tokenRole === 'tester') {
            console.log("[AUTH DEBUG] Role is 'tester'. Responding with 'tester'.");
            return res.status(200).json({ role: 'tester' });
        }

        if (tokenRole === 'supporter') {
            console.log("[AUTH DEBUG] Role is 'supporter'. Responding with 'supporter'.");
            return res.status(200).json({ role: 'supporter' });
        }

        if (tokenRole === 'owner') {
            console.log("[AUTH DEBUG] Role is 'owner'. Checking subscription status in Firestore...");
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();

            if (!userDoc.exists) {
                console.log("[AUTH DEBUG] User document not found in Firestore. Responding with 'supporter'.");
                return res.status(200).json({ role: 'supporter' });
            }

            const userData = userDoc.data();
            const status = userData?.subscriptionStatus;
            const expiresAt = userData?.expiresAt;
            console.log(`[AUTH DEBUG] Firestore data: status=${status}, expiresAt=${expiresAt}`);

            if (status === 'active') {
                if (expiresAt && new Date(expiresAt) < new Date()) {
                    console.log("[AUTH DEBUG] Subscription is expired. Responding with 'supporter'.");
                    return res.status(200).json({ role: 'supporter' });
                } else {
                    console.log("[AUTH DEBUG] Subscription is active. Responding with 'owner'.");
                    return res.status(200).json({ role: 'owner' });
                }
            } else {
                console.log("[AUTH DEBUG] Subscription status is not 'active'. Responding with 'supporter'.");
                return res.status(200).json({ role: 'supporter' });
            }
        }

        console.log(`[AUTH DEBUG] Role '${tokenRole}' did not match any condition. Responding with 'supporter'.`);
        res.status(200).json({ role: 'supporter' });

    } catch (error) {
        console.error("[AUTH DEBUG] !!! An error occurred in /status endpoint !!!", error);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
    // --- ★★★ ここまでデバッグログを追加 ★★★ ---
});

export default router;