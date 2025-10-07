import { Router } from 'express';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';
import { client } from '../index';
import { ChannelType } from 'discord.js';

const router = Router({ mergeParams: true }); // ★ mergeParamsオプションを追加

const CACHE_DURATION = 10 * 60 * 1000; // 10分

// GET /
router.get('/', protect, async (req: AuthRequest, res) => { // ★ パスを'/'に変更
  try {
    const { serverId } = req.params; // ★ 親ルーターから serverId を受け取る
    const forceRefresh = req.query['force-refresh'] === 'true';
    const serverRef = db.collection('servers').doc(serverId);
    const serverDoc = await serverRef.get();
    const serverData = serverDoc.data();

    if (!forceRefresh && serverData?.channels && serverData?.channelsFetchedAt) {
      const lastFetched = serverData.channelsFetchedAt.toMillis();
      if (Date.now() - lastFetched < CACHE_DURATION) {
        return res.status(200).json(serverData.channels);
      }
    }

    const guild = await client.guilds.fetch(serverId);
    if (!guild) {
      return res.status(404).json({ message: "Bot is not a member of this server." });
    }
    const channels = await guild.channels.fetch();
    const textChannels = channels
      .filter(channel => channel?.type === ChannelType.GuildText)
      .map(channel => ({ id: channel!.id, name: `#${channel!.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));

    await serverRef.set({
      channels: textChannels,
      channelsFetchedAt: new Date(),
    }, { merge: true });

    res.status(200).json(textChannels);

  } catch (error: any) {
    console.error('Failed to fetch channels:', error.message);
    res.status(500).json({ message: 'Failed to fetch channels' });
  }
});

export default router;