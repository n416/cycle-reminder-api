import { Router } from 'express';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';
import { client } from '../index';

const router = Router({ mergeParams: true });

const CACHE_DURATION = 10 * 60 * 1000;

router.get('/', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const forceRefresh = req.query['force-refresh'] === 'true';
    const serverRef = db.collection('servers').doc(serverId);

    console.log(`%c[Emojis API] Request received for server: ${serverId}`, 'color: #f0a; font-weight: bold;');
    console.log(`[Emojis API] Force refresh requested: ${forceRefresh}`);

    if (!forceRefresh) {
      const serverDoc = await serverRef.get();
      const serverData = serverDoc.data();
      if (serverData?.emojis && serverData?.emojisFetchedAt) {
        const lastFetched = serverData.emojisFetchedAt.toMillis();
        if (Date.now() - lastFetched < CACHE_DURATION) {
          console.log('[Emojis API] Cache is valid. Serving from cache.');
          return res.status(200).json(serverData.emojis);
        }
        console.log('[Emojis API] Cache is expired.');
      } else {
        console.log('[Emojis API] No cache found.');
      }
    }

    console.log('[Emojis API] Fetching guild object from Discord API...');
    const guild = await client.guilds.fetch(serverId);
    
    // --- ★★★ ここから調査用ログを追加 ★★★ ---
    console.log('[Emojis API] Guild object fetched. Inspecting properties...');
    console.log(guild); // guildオブジェクトの中身をすべて表示

    if (!guild) {
      console.log('[Emojis API] Guild not found on Discord.');
      return res.status(404).json({ message: "Bot is not a member of this server." });
    }
    
    // emojisプロパティが存在するかどうかを安全にチェック
    if (!guild.emojis) {
        console.error('[Emojis API] FATAL: guild.emojis property is undefined! The fetched guild object is incomplete.');
        return res.status(500).json({ message: 'Failed to access guild emojis. The guild object may be incomplete.' });
    }
    console.log('[Emojis API] guild.emojis property found. Proceeding to fetch emojis.');
    // --- ★★★ ここまで追加 ★★★ ---
    
    const emojisCollection = await guild.emojis.fetch();
    console.log(`[Emojis API] Found ${emojisCollection.size} emojis on Discord.`);

    const emojis = emojisCollection.map(emoji => ({
      id: emoji.id,
      name: emoji.name,
      url: emoji.url,
      animated: emoji.animated,
    }));

    console.log('[Emojis API] Saving new data to cache...');
    await serverRef.set({
      emojis: emojis,
      emojisFetchedAt: new Date(),
    }, { merge: true });

    console.log('[Emojis API] Sending response with new data.');
    res.status(200).json(emojis);

  } catch (error: any) {
    console.error('Failed to fetch emojis:', error.message);
    res.status(500).json({ message: 'Failed to fetch emojis' });
  }
});

export default router;