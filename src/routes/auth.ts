import { Router } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { db } from '../config/firebase';

dotenv.config();
const router = Router();

router.get('/discord', (_req, res) => {
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI!)}&response_type=code&scope=identify%20guilds`;
  res.redirect(discordAuthUrl);
});

router.get('/discord/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error === 'access_denied') {
    return res.redirect(`${process.env.FRONTEND_URL}/login`);
  }

  if (!code) {
    return res.status(400).send('No code provided');
  }

  try {
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID!,
      client_secret: process.env.DISCORD_CLIENT_SECRET!,
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: process.env.DISCORD_REDIRECT_URI!,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    
    const { access_token, refresh_token } = tokenResponse.data;

    const [userResponse, guildsResponse] = await Promise.all([
      axios.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` },
      }),
      axios.get('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${access_token}` },
      })
    ]);
    
    const user = userResponse.data;
    const guilds = guildsResponse.data;

    const userRef = db.collection('users').doc(user.id);
    await userRef.set({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      accessToken: access_token,
      refreshToken: refresh_token,
      guilds: guilds,
    }, { merge: true });

    const appToken = jwt.sign({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
    }, process.env.DISCORD_CLIENT_SECRET!, { expiresIn: '7d' });

    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${appToken}`);

  } catch (error: any) {
    console.error('Error during Discord auth:', error.response?.data || error.message);
    res.status(500).send('Authentication failed');
  }
});

export default router;