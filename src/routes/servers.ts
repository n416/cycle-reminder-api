import { Router } from 'express';
import { db } from '../config/firebase';
// ★★★ protectWrite が auth.ts からエクスポートされていることを確認してください ★★★
import { protect, AuthRequest, protectWrite } from '../middleware/auth';
import { client } from '../index';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
// ★★★ FieldValue に加えて FieldPath をインポート ★★★
import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import channelsRouter from './channels';
import emojisRouter from './emojis';

const router = Router();
const serversCollection = db.collection('servers'); // ★ サーバー設定を保存するコレクション

// 各サーバーに紐づくチャンネルと絵文字のエンドポイント
router.use('/:serverId/channels', channelsRouter);
router.use('/:serverId/emojis', emojisRouter);

// GET /api/servers - ユーザーがアクセス可能なサーバー一覧を取得
router.get('/', protect, async (req: AuthRequest, res) => {
  try {
    const userId = req.user.id;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: 'User not found in database' });
    }
    const userData = userDoc.data()!;
    const { guilds } = userData; // Discordから取得したサーバー情報
    const subscriptionStatus = req.user.role; // アプリ内の役割（owner, tester, supporter）

    if (!guilds) {
      return res.status(404).json({ message: 'Guilds not found for user. Please try logging in again.' });
    }

    // ★★★ データベースからカスタム設定を一括取得 ★★★
    const serverIds = guilds.map((g: any) => g.id);
    const serverSettings: { [key: string]: any } = {};
    if (serverIds.length > 0) { // serverIdsが空の場合のエラーを防ぐ
        // ★★★★★ ここを FieldValue -> FieldPath に修正 ★★★★★
        const serverSettingsSnap = await serversCollection.where(FieldPath.documentId(), 'in', serverIds).get();
        // ★★★★★ ここまで ★★★★★
        serverSettingsSnap.forEach(doc => {
            // パスワードハッシュはフロントに送らない
            const { passwordHash, ...settings } = doc.data();
            serverSettings[doc.id] = settings;
        });
    }
    // ★★★ ここまで ★★★

    const botGuilds = new Set(client.guilds.cache.map(g => g.id)); // BOTが参加しているサーバーIDのセット

    const servers = guilds.map((guild: any) => {
      const permissions = BigInt(guild.permissions);
      const isDiscordAdmin = (permissions & BigInt(0x20)) === BigInt(0x20); // Discordサーバーの管理者か

      // アプリ内での役割とDiscord権限を組み合わせて最終的な役割を決定
      let finalRole: 'admin' | 'member' = 'member';
      if (subscriptionStatus === 'tester' || subscriptionStatus === 'owner' || (subscriptionStatus === 'active' && isDiscordAdmin)) {
        finalRole = 'admin'; // オーナー、テスター、または課金済みDiscord管理者は admin
      } else if (isDiscordAdmin) {
        finalRole = 'admin'; // 課金してなくてもDiscord管理者なら admin (設定はできないが一覧では区別)
      }

      // ★★★ カスタム設定をマージして返す ★★★
      const settings = serverSettings[guild.id] || {};

      return {
        id: guild.id,
        name: guild.name,        // Discordのサーバー名
        icon: guild.icon,        // Discordのアイコンハッシュ
        role: finalRole,         // アプリ内での役割
        isAdded: botGuilds.has(guild.id), // BOTが導入済みか
        customName: settings.customName || null,   // 上書き名
        customIcon: settings.customIcon || null,   // 上書きアイコンURL
        serverType: settings.serverType || 'normal', // サーバー種別
      }
    });
    res.status(200).json(servers);
  } catch (error: any) {
    console.error('Failed to fetch guilds:', error.message);
    res.status(500).json({ message: 'Failed to fetch guilds' });
  }
});

// PUT /api/servers/:serverId/settings - サーバーのカスタム設定を更新
router.put('/:serverId/settings', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { customName, customIcon, serverType } = req.body;

    // 簡単なバリデーション
    if (!['normal', 'hit_the_world'].includes(serverType)) {
      return res.status(400).json({ message: 'Invalid serverType.' });
    }
    // customIcon が URL 形式かどうかのバリデーションなどもここに追加可能

    const settingsData = {
      // 値が falsy (空文字など) の場合は null として保存する
      customName: customName || null,
      customIcon: customIcon || null,
      serverType: serverType,
    };

    // Firestore にデータを保存 (merge: true で既存のフィールドを上書きしないようにする)
    await serversCollection.doc(serverId).set(settingsData, { merge: true });

    // 保存したデータをそのまま返す
    res.status(200).json(settingsData);

  } catch (error: any) {
    console.error('サーバー設定の更新中にエラーが発生しました:', error.message);
    res.status(500).json({ message: 'Failed to update server settings' });
  }
});

// PUT /api/servers/:serverId/password - パスワードを設定/削除
router.put('/:serverId/password', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;

    // パスワード設定権限チェック（オーナー or テスターか？）
    const appRole = req.user.role;
    if (appRole !== 'owner' && appRole !== 'tester') {
        return res.status(403).json({ message: 'Forbidden: Only owners or testers can change server settings.' });
    }

    // さらに、そのサーバーのDiscord管理者である必要もある
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

    const serverRef = serversCollection.doc(serverId);

    if (password && typeof password === 'string') {
      // パスワード設定
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      await serverRef.set({ passwordHash }, { merge: true }); // merge: true で他の設定を消さない
      res.status(200).json({ message: 'Password updated successfully.' });
    } else {
      // パスワード削除
      await serverRef.update({ passwordHash: FieldValue.delete() });
      res.status(200).json({ message: 'Password removed successfully.' });
    }
  } catch (error: any) {
    console.error('パスワード設定中に予期せぬエラーが発生しました:', error.message);
    res.status(500).json({ message: 'Failed to update password' });
  }
});

// POST /api/servers/:serverId/verify-password - パスワードを検証して書き込みトークンを取得
router.post('/:serverId/verify-password', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;
    const appRole = req.user.role;

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: 'User not found in our database.' });
    }

    const userData = userDoc.data();
    const serverInfo = userData?.guilds.find((g: any) => g.id === serverId);
    if (!serverInfo) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this server.' });
    }

    const isDiscordAdmin = (BigInt(serverInfo.permissions) & BigInt(0x20)) === BigInt(0x20);
    const hasOwnerRights = (appRole === 'owner') && isDiscordAdmin;
    const isAppTester = appRole === 'tester';

    // オーナーかテスターならパスワード不要でトークン発行
    if (hasOwnerRights || isAppTester) {
      const writeToken = jwt.sign(
        { userId: userId, serverId: serverId, grant: 'write' },
        process.env.DISCORD_CLIENT_SECRET!, { expiresIn: '1h' }
      );
      return res.status(200).json({ writeToken });
    }

    // サポーターの場合、パスワードが設定されているか確認
    const serverDoc = await serversCollection.doc(serverId).get();
    const serverData = serverDoc.data();

    // パスワードが設定されていなければ、サポーターでもトークン発行
    if (!serverData || !serverData.passwordHash) {
      const writeToken = jwt.sign(
        { userId: userId, serverId: serverId, grant: 'write' },
        process.env.DISCORD_CLIENT_SECRET!, { expiresIn: '1h' }
      );
      return res.status(200).json({ writeToken });
    }

    // パスワードが設定されている場合は、入力されたパスワードを検証
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ message: 'Password is required.' });
    }

    const isValid = await bcrypt.compare(password, serverData.passwordHash);
    if (!isValid) {
      return res.status(403).json({ message: 'Invalid password.' });
    }

    // パスワードが正しければトークン発行
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

// GET /api/servers/:serverId/password-status - パスワードが設定されているか確認
router.get('/:serverId/password-status', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const serverRef = serversCollection.doc(serverId);
    const serverDoc = await serverRef.get();

    if (serverDoc.exists && serverDoc.data()?.passwordHash) {
      res.status(200).json({ hasPassword: true });
    } else {
      res.status(200).json({ hasPassword: false });
    }
  } catch (error) {
    res.status(500).json({ message: 'Failed to check password status.' });
  }
});

export default router;