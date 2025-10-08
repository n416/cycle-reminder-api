import { Router } from 'express';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';
import { client } from '../index';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { FieldValue } from 'firebase-admin/firestore';
import channelsRouter from './channels'; // ★ channelsRouterをインポート
import emojisRouter from './emojis'; // ★ emojisRouterをインポート

const router = Router();

// /:serverId/channels へのリクエストをchannelsRouterに委譲する
router.use('/:serverId/channels', channelsRouter);
router.use('/:serverId/emojis', emojisRouter); // ★ emojisRouterを登録

// GET / - ユーザーが所属するサーバー一覧を取得
router.get('/', protect, async (req: AuthRequest, res) => {
  try {
    const userId = req.user.id;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: 'User not found in database' });
    }
    const { guilds } = userDoc.data()!;
    if (!guilds) {
      return res.status(404).json({ message: 'Guilds not found for user. Please try logging in again.' });
    }
    const botGuilds = new Set(client.guilds.cache.map(g => g.id));
    const servers = guilds.map((guild: any) => {
      const permissions = BigInt(guild.permissions);
      const isAdmin = (permissions & BigInt(0x20)) === BigInt(0x20);
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        role: isAdmin ? 'admin' : 'member',
        isAdded: botGuilds.has(guild.id),
      }
    });
    res.status(200).json(servers);
  } catch (error: any) {
    console.error('Failed to fetch guilds:', error.message);
    res.status(500).json({ message: 'Failed to fetch guilds' });
  }
});

// PUT /:serverId/password - パスワードを設定
router.put('/:serverId/password', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    const serverInfo = userData?.guilds.find((g: any) => g.id === serverId);

    if (!serverInfo) {
      return res.status(403).json({ message: 'Forbidden: User is not a member of this server.' });
    }
    const permissions = BigInt(serverInfo.permissions);
    const isAdmin = (permissions & BigInt(0x20)) === BigInt(0x20);
    if (!isAdmin) {
      return res.status(403).json({ message: 'Forbidden: User is not an admin of this server.' });
    }

    const serverRef = db.collection('servers').doc(serverId);
    const serverDoc = await serverRef.get();

    if (password && typeof password === 'string') {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      const dataToSave = { passwordHash };

      if (serverDoc.exists) {
        await serverRef.update(dataToSave);
      } else {
        await serverRef.set(dataToSave);
      }
      res.status(200).json({ message: 'Password updated successfully.' });

    } else {
      if (serverDoc.exists) {
        await serverRef.update({ passwordHash: FieldValue.delete() });
        res.status(200).json({ message: 'Password removed successfully.' });
      } else {
        res.status(200).json({ message: 'Password was not set, nothing to remove.' });
      }
    }
  } catch (error: any) {
    console.error('パスワード設定中に予期せぬエラーが発生しました:', error.message);
    res.status(500).json({ message: 'Failed to update password' });
  }
});

// POST /:serverId/verify-password - パスワードを検証
router.post('/:serverId/verify-password', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: 'User not found in our database.' });
    }
    
    const userData = userDoc.data();
    const serverInfo = userData?.guilds.find((g: any) => g.id === serverId);
    if (!serverInfo) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this server.' });
    }
    
    const permissions = BigInt(serverInfo.permissions);
    const isAdmin = (permissions & BigInt(0x20)) === BigInt(0x20);

    if (isAdmin) {
      const writeToken = jwt.sign(
        { userId: userId, serverId: serverId, grant: 'write' },
        process.env.DISCORD_CLIENT_SECRET!, { expiresIn: '1h' }
      );
      return res.status(200).json({ writeToken });
    }

    const serverDoc = await db.collection('servers').doc(serverId).get();
    const serverData = serverDoc.data();

    if (!serverData || !serverData.passwordHash) {
      return res.status(403).json({ message: 'A password has not been set for this server.' });
    }
    
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ message: 'Password is required.' });
    }

    const isValid = await bcrypt.compare(password, serverData.passwordHash);
    if (!isValid) {
      return res.status(403).json({ message: 'Invalid password.' });
    }

    const writeToken = jwt.sign(
      { userId: userId, serverId: serverId, grant: 'write' },
      process.env.DISCORD_CLIENT_SECRET!, { expiresIn: '1h' }
    );
    res.status(200).json({ writeToken });

  } catch (error: any) {
    console.error('パスワード検証中に予期せぬエラーが発生しました:', error.message);
    res.status(500).json({ message: 'Failed to verify password' });
  }
});


export default router;