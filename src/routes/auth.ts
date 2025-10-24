import { Router, Request, Response } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';
import { DocumentData } from 'firebase-admin/firestore';

dotenv.config();
const router = Router();

const TESTER_PASSWORD = process.env.TESTER_PASSWORD;
if (!TESTER_PASSWORD) {
    console.warn("Warning: TESTER_PASSWORD is not set. Tester login will be disabled.");
}

const hasActiveSubscription = (userData: DocumentData | null | undefined): boolean => {
    if (!userData) {
        return false;
    }
    const status = userData.subscriptionStatus;
    const expiresAt = userData.expiresAt;

    if (status !== 'active') {
        return false;
    }

    if (expiresAt) {
        if (new Date(expiresAt) < new Date()) {
            return false;
        }
    }
    
    return true;
};

router.post('/verify-tester', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!TESTER_PASSWORD || password !== TESTER_PASSWORD) {
        return res.status(401).json({ message: 'Invalid tester password.' });
    }
    res.status(200).json({ message: 'Tester password verified.' });
});

router.get('/discord', (req: Request, res: Response) => {
    const { role, redirectPath } = req.query;
    if (role !== 'owner' && role !== 'supporter' && role !== 'tester') {
        return res.status(400).send('Invalid role specified.');
    }
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
        
        // ★★★★★ ここからが修正箇所です ★★★★★
        let sessionRole: 'owner' | 'tester' | 'supporter';

        if (roleIntent === 'owner') {
            const userDoc = await userRef.get();
            if (hasActiveSubscription(userDoc.data())) {
                sessionRole = 'owner';
            } else {
                // 課金していない場合は、一時的にサポーターとしてトークンを発行
                sessionRole = 'supporter';
            }
        } else {
            sessionRole = roleIntent;
        }

        const appToken = jwt.sign(
            {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                role: sessionRole // 検証済みの役割をトークンに含める
            },
            process.env.DISCORD_CLIENT_SECRET!,
            { expiresIn: '7d' }
        );
        // ★★★★★ ここまで ★★★★★

        const finalRedirectPath = redirectPath || '/servers';
        res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${appToken}&role_intent=${roleIntent}&redirectPath=${encodeURIComponent(finalRedirectPath)}`);

    } catch (e: any) {
        console.error("【バックエンド】Discord認証コールバックでエラー:", e.response?.data || e.message);
        res.redirect(`${frontendLoginUrl}?error=authentication_failed`);
    }
});

router.get('/status', protect, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.id;
        const tokenRole = req.user.role;

        if (!userId) {
            return res.status(401).json({ role: 'supporter' });
        }

        if (tokenRole === 'tester') {
            return res.status(200).json({ role: 'tester' });
        }

        if (tokenRole === 'supporter') {
            return res.status(200).json({ role: 'supporter' });
        }

        if (tokenRole === 'owner') {
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();
            
            if (hasActiveSubscription(userDoc.data())) {
                return res.status(200).json({ role: 'owner' });
            } else {
                return res.status(200).json({ role: 'supporter' });
            }
        }

        res.status(200).json({ role: 'supporter' });

    } catch (error) {
        console.error("[AUTH DEBUG] !!! エラーが発生しました !!!", error);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

export default router;