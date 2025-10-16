import { Router } from 'express';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';
import { client } from '../index';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { FieldValue } from 'firebase-admin/firestore';
import channelsRouter from './channels';
import emojisRouter from './emojis';

const router = Router();

router.use('/:serverId/channels', channelsRouter);
router.use('/:serverId/emojis', emojisRouter);

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

router.put('/:serverId/password', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    const appRole = userData?.subscriptionStatus;
    if (appRole !== 'active' && appRole !== 'tester') {
      return res.status(403).json({ message: 'Forbidden: Only owners or testers can change server settings.' });
    }

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


// ★★★★★ ここからが修正箇所です ★★★★★
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

    // --- 新しい、より明確な権限チェックロジック ---
    const isDiscordAdmin = (BigInt(serverInfo.permissions) & BigInt(0x20)) === BigInt(0x20);
    const appRole = userData?.subscriptionStatus;

    // 条件1: オーナー（有料会員）かつDiscord管理者である
    const hasOwnerRights = (appRole === 'active') && isDiscordAdmin;
    // 条件2: テスターである（Discordの権限は問わない）
    const isAppTester = appRole === 'tester';

    // オーナーまたはテスターであれば、パスワード不要で即時トークンを発行
    if (hasOwnerRights || isAppTester) {
      const writeToken = jwt.sign(
        { userId: userId, serverId: serverId, grant: 'write' },
        process.env.DISCORD_CLIENT_SECRET!, { expiresIn: '1h' }
      );
      return res.status(200).json({ writeToken });
    }

    // --- 上記以外のユーザー（サポーターなど）のためのパスワード検証ロジック ---
    const serverDoc = await db.collection('servers').doc(serverId).get();
    const serverData = serverDoc.data();

    // まず、サーバーにパスワードが設定されているかを確認する
    if (!serverData || !serverData.passwordHash) {
      // 設定されていなければ、明確に「権限がない」とだけ伝える
      return res.status(403).json({ message: 'Forbidden: You do not have sufficient permissions.' });
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
// ★★★★★ ここまで ★★★★★

export default router;