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

router.get('/discord', (req: Request, res: Response) => {
    const { role } = req.query;
    if (role !== 'owner' && role !== 'supporter' && role !== 'tester') {
        return res.status(400).send('Invalid role specified.');
    }
    const state = Buffer.from(JSON.stringify({ role })).toString('base64');
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
    try {
        const decodedState = JSON.parse(Buffer.from(state as string, 'base64').toString('utf-8'));
        roleIntent = decodedState.role;
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

        // ★★★★★ ここからが新しい権限ロジックです ★★★★★

        let sessionRole: 'owner' | 'tester' | 'supporter';

        // デフォルトでは、ログイン時の意図をそのままセッションの役割とする
        sessionRole = roleIntent;

        // ただし、オーナーとしてログインしようとした場合のみ、資格を厳格にチェックする
        if (roleIntent === 'owner') {
            const userDoc = await userRef.get();
            const userData = userDoc.exists ? userDoc.data() : null;
            const isPaidUser = userData?.subscriptionStatus === 'active' && (!userData?.expiresAt || new Date(userData.expiresAt) >= new Date());
            
            if (!isPaidUser) {
                // 資格がないのにオーナーとしてログインしようとした場合は、ログインを失敗させ、エラーと共にログインページに戻す
                return res.redirect(`${frontendLoginUrl}?error=no_permission_for_owner`);
            }
            // 資格があれば、セッションの役割は 'owner' のまま
        }

        // 'tester' や 'supporter' の意図は、フロントエンドでの事前認証を信頼し、そのまま通す

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

        res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${appToken}&role_intent=${roleIntent}`);
        // ★★★★★ ここまで ★★★★★

    } catch (e: any) {
        console.error("【バックエンド】Discord認証コールバックでエラー:", e.response?.data || e.message);
        res.redirect(`${frontendLoginUrl}?error=authentication_failed`);
    }
});

// ★★★★★ ここからが修正箇所です (GET /status) ★★★★★
router.get('/status', protect, async (req: AuthRequest, res: Response) => {
    
    // --- デバッグログ ---
    console.log("\n--- [AUTH DEBUG] /api/auth/status が呼び出されました (V2) ---");

    try {
        const userId = req.user.id;
        const tokenRole = req.user.role; // ★ トークン（JWT）から role を取得
        
        console.log(`[AUTH DEBUG] 1. トークンから取得した User ID: ${userId}`);
        console.log(`[AUTH DEBUG] 2. トークンに記録された Role: '${tokenRole}'`);

        if (!userId) {
            console.log("[AUTH DEBUG] -> User ID がないため 'supporter' で終了します。");
            return res.status(401).json({ role: 'supporter' });
        }

        // 3. ログイン時の役割（トークンの役割）を最優先で確認
        
        // 3a. もし 'tester' としてログインしていたら、DBの状態に関わらず 'tester'
        if (tokenRole === 'tester') {
            console.log("[AUTH DEBUG] -> トークンロールが 'tester' のため、'tester' を返します。");
            return res.status(200).json({ role: 'tester' });
        }
        
        // 3b. もし 'supporter' としてログインしていたら、'supporter'
        if (tokenRole === 'supporter') {
            console.log("[AUTH DEBUG] -> トークンロールが 'supporter' のため、'supporter' を返します。");
            return res.status(200).json({ role: 'supporter' });
        }

        // 3c. もし 'owner' としてログインしていた場合のみ、DBをチェックして降格判定
        if (tokenRole === 'owner') {
            console.log("[AUTH DEBUG] 4. トークンロールが 'owner' のため、DBで有効期限を検証します...");
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();

            if (!userDoc.exists) {
                console.log("[AUTH DEBUG] -> 'owner' トークンだがDBに実体がないため 'supporter' に降格します。");
                return res.status(200).json({ role: 'supporter' });
            }

            const userData = userDoc.data();
            const status = userData?.subscriptionStatus;
            const expiresAt = userData?.expiresAt;
            console.log(`[AUTH DEBUG] 5. DB Status: '${status}', ExpiresAt: '${expiresAt}'`);

            if (status === 'active') {
                if (expiresAt && new Date(expiresAt) < new Date()) {
                    console.log("[AUTH DEBUG] -> 'active' ですが期限切れのため 'supporter' に降格します。");
                    return res.status(200).json({ role: 'supporter' }); // 期限切れ
                } else {
                    console.log("[AUTH DEBUG] -> 'active' (有効) のため 'owner' を維持します。");
                    return res.status(200).json({ role: 'owner' }); // 有効
                }
            } else {
                console.log(`[AUTH DEBUG] -> DB Status が 'active' ではないため 'supporter' に降格します。`);
                return res.status(200).json({ role: 'supporter' });
            }
        }

        // 4. 'unknown' またはその他のロールがトークンにあった場合
        console.log(`[AUTH DEBUG] -> 不明なトークンロール ('${tokenRole}') のため 'supporter' を返します。`);
        res.status(200).json({ role: 'supporter' });

    } catch (error) {
        console.error("[AUTH DEBUG] !!! エラーが発生しました !!!", error);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});
// ★★★★★ ここまで ★★★★★

export default router;