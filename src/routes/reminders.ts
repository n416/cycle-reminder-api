import { Router } from 'express';
import { db } from '../config/firebase';
import { protect, protectWrite, AuthRequest } from '../middleware/auth';
import { Reminder } from '../types';
import { client } from '../index';
import { TextChannel } from 'discord.js';

const router = Router();
const remindersCollection = db.collection('reminders');
const auditLogsCollection = db.collection('auditLogs');

const addLogWithTrim = async (logData: object) => {
  await auditLogsCollection.add({
    ...logData,
    timestamp: new Date().toISOString(),
  });
  const snapshot = await auditLogsCollection.orderBy('timestamp', 'desc').get();
  if (snapshot.size > 30) {
    const oldestDoc = snapshot.docs[snapshot.docs.length - 1];
    await oldestDoc.ref.delete();
  }
};

/**
 * 次に実行すべき通知の情報を計算する
 * @param reminderData リマインダーのデータ
 * @param baseTime 計算の基準となる現在時刻
 * @returns { { nextNotificationTime: Date | null, nextOffsetIndex: number | null } } 次の通知時刻と、そのオフセットのインデックス
 */
const calculateNextNotificationInfo = (
  reminderData: Omit<Reminder, 'id' | 'createdBy' | 'channel' | 'message' | 'status'>,
  baseTime: Date
): { nextNotificationTime: Date | null; nextOffsetIndex: number | null } => {

  // ★★★ 複雑な型判定をやめ、stringを直接Dateに変換 ★★★
  const startDate = new Date(reminderData.startTime);
  if (isNaN(startDate.getTime())) return { nextNotificationTime: null, nextOffsetIndex: null };

  // --- 1. 次の「本来の実行時刻」（サイクルの起点）を計算する ---
  let nextCycleTime: Date | null = null; // ★★★ 初期値を null に設定 ★★★

  switch (reminderData.recurrence.type) {
    case 'none':
      nextCycleTime = startDate >= baseTime ? startDate : null;
      break;

    case 'daily': {
      let nextDate = baseTime > startDate ? new Date(baseTime) : new Date(startDate);
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
      if (nextDate <= baseTime) {
        nextDate.setDate(nextDate.getDate() + 1);
      }
      nextCycleTime = nextDate;
      break;
    }

    case 'interval': {
      let nextDate = new Date(startDate);
      while (nextDate <= baseTime) {
        nextDate.setHours(nextDate.getHours() + reminderData.recurrence.hours);
      }
      nextCycleTime = nextDate;
      break;
    }

    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminderData.recurrence.days.map(day => dayMap[day]));
      if (targetDaysOfWeek.size === 0) {
        nextCycleTime = null;
        break;
      }
      let nextDate = baseTime > startDate ? new Date(baseTime) : new Date(startDate);
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
      if (nextDate <= baseTime) {
        nextDate.setDate(nextDate.getDate() + 1);
      }
      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          nextCycleTime = nextDate;
          break; // 見つかったらループを抜ける
        }
        nextDate.setDate(nextDate.getDate() + 1);
      }
      // ★ ループ後に nextCycleTime が null のままなら何もしない (初期値のまま)
      break;
    }
    default:
      nextCycleTime = null;
  }

  // 次のサイクルが見つからなければ、通知も存在しない
  if (!nextCycleTime) {
    return { nextNotificationTime: null, nextOffsetIndex: null };
  }

  // --- 2. オフセットを適用して、実際に通知すべき時刻を探す ---
  const offsets = reminderData.notificationOffsets || [0]; // オフセットがなければ [0] (時間丁度) とみなす

  // 複数のオフセットの中から、「今」以降で一番近い（最初に来る）通知を探す
  for (let i = 0; i < offsets.length; i++) {
    const offsetMinutes = offsets[i];
    const notificationTime = new Date(nextCycleTime.getTime() - offsetMinutes * 60 * 1000);

    // その通知時刻が「今」より後であれば、それが次に通知すべき時刻
    if (notificationTime > baseTime) {
      return {
        nextNotificationTime: notificationTime,
        nextOffsetIndex: i
      };
    }
  }

  // 「今」を過ぎていないオフセット通知が一つもなかった場合
  // (例: 12:30のボスに対し、[10, 5]オフセットを設定していて、現在時刻が12:28の場合)
  // → このサイクルの通知はすべて終わっているので、次のサイクルの最初の通知を探す必要がある
  // (この処理はスケジューラー側で行うので、ここでは null を返す)
  return { nextNotificationTime: null, nextOffsetIndex: null };
};
// ★★★★★ ここまで ★★★★★

const sanitizeMessage = (message: string): string => {
  return message
    .replace(/@everyone/g, '＠everyone')
    .replace(/@here/g, '＠here')
    .replace(/<@&(\d+)>/g, '＠ロール')
    .replace(/<@!?(\d+)>/g, '＠ユーザー');
};

router.get('/:serverId', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const snapshot = await remindersCollection.where('serverId', '==', serverId).get();
    const reminders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(reminders);
  } catch (error) {
    console.error("Failed to fetch reminders:", error);
    res.status(500).json({ error: 'Failed to fetch reminders' });
  }
});

// ★★★★★ POST /:serverId の修正 ★★★★★
router.post('/:serverId', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { userId, ...reminderData } = req.body;

    // オフセットをパースし、降順にソート
    const offsets = (reminderData.notificationOffsets || [0])
      .filter((n: number) => typeof n === 'number' && n >= 0)
      .sort((a: number, b: number) => b - a);

    const dataWithOffsets = {
      ...reminderData,
      notificationOffsets: offsets.length > 0 ? offsets : [0], // 空の場合は[0]を保証
    };

    const { nextNotificationTime, nextOffsetIndex } = calculateNextNotificationInfo(dataWithOffsets as any, new Date());

    const newReminderData = {
      ...dataWithOffsets,
      serverId: serverId,
      createdBy: req.user.id,
      nextNotificationTime: nextNotificationTime, // Timestamp
      nextOffsetIndex: nextOffsetIndex,
      selectedEmojis: reminderData.selectedEmojis || [],
    };

    const docRef = await remindersCollection.add(newReminderData);
    const result = { id: docRef.id, ...newReminderData };

    await addLogWithTrim({
      user: req.user.username,
      action: '作成',
      reminderMessage: result.message,
      after: result,
      serverId: serverId,
    });

    res.status(201).json(result);
  } catch (error) {
    console.error("Failed to create reminder:", error);
    res.status(500).json({ error: 'Failed to create reminder' });
  }
});

// ★★★★★ PUT /:id の修正 ★★★★★
router.put('/:id', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const docRef = remindersCollection.doc(id);
    const beforeSnap = await docRef.get();
    const beforeData = beforeSnap.data();

    if (!beforeData) {
      return res.status(404).json({ error: "Reminder not found." });
    }

    // オフセットをパースし、降順にソート
    const offsets = (req.body.notificationOffsets || [0])
      .filter((n: number) => typeof n === 'number' && n >= 0)
      .sort((a: number, b: number) => b - a);

    const updatedData = {
      ...req.body,
      notificationOffsets: offsets.length > 0 ? offsets : [0],
      selectedEmojis: req.body.selectedEmojis || [],
    };

    const { nextNotificationTime, nextOffsetIndex } = calculateNextNotificationInfo(updatedData as any, new Date());

    await docRef.update({
      ...updatedData,
      nextNotificationTime, // Timestamp
      nextOffsetIndex,
    });

    await addLogWithTrim({
      user: req.user.username,
      action: '更新',
      reminderMessage: updatedData.message,
      before: { id, ...beforeData },
      after: { id, ...updatedData, nextNotificationTime, nextOffsetIndex },
      serverId: beforeData.serverId,
    });

    res.status(200).json({ id, ...updatedData, nextNotificationTime, nextOffsetIndex });
  } catch (error) {
    console.error("Failed to update reminder:", error);
    res.status(500).json({ error: 'Failed to update reminder' });
  }
});


router.delete('/:id', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const docRef = remindersCollection.doc(id);
    const beforeSnap = await docRef.get();
    const beforeData = beforeSnap.data();

    if (!beforeData) {
      return res.status(404).json({ error: "Reminder not found." });
    }

    await docRef.delete();

    if (beforeData) {
      await addLogWithTrim({
        user: req.user.username,
        action: '削除',
        reminderMessage: beforeData.message,
        before: { id, ...beforeData },
        serverId: beforeData.serverId,
      });
    }

    res.status(200).json({ message: 'Reminder deleted successfully' });
  } catch (error) {
    console.error("Failed to delete reminder:", error);
    res.status(500).json({ error: 'Failed to delete reminder' });
  }
});

router.post('/:serverId/test-send', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { channelId, message, selectedEmojis } = req.body;

    if (!channelId || !message) {
      return res.status(400).json({ message: 'channelId and message are required.' });
    }

    const channel = await client.channels.fetch(channelId);
    if (channel && channel instanceof TextChannel) {
      const testMessage = `＝＝＝テスト送信です＝＝＝\n${sanitizeMessage(message)}`;
      const sentMessage = await channel.send(testMessage);

      if (selectedEmojis && selectedEmojis.length > 0) {
        for (const emojiId of selectedEmojis) {
          try {
            await sentMessage.react(emojiId);
          } catch (reactError) {
            console.warn(`[Test Send] Failed to react with emoji ${emojiId}.`);
          }
        }
      }

      res.status(200).json({ message: 'Test message sent successfully.' });
    } else {
      res.status(404).json({ message: 'Channel not found or is not a text channel.' });
    }
  } catch (error) {
    console.error("Failed to send test message:", error);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});

/**
 * 「24時間以内の予定」リマインダーを簡易作成するための専用エンドポイント
 */
router.post('/:serverId/daily-summary', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { channelId, time } = req.body;

    if (!channelId || !time || !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: 'channelId and time (HH:mm format) are required.' });
    }

    let channelName = '';
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel instanceof TextChannel) {
        channelName = channel.name;
      } else {
        return res.status(404).json({ error: 'Channel not found or is not a text channel.' });
      }
    } catch (e) {
      console.error("Failed to fetch channel details:", e);
      return res.status(404).json({ error: 'Channel not found.' });
    }

    const [hours, minutes] = time.split(':').map(Number);
    const startTime = new Date();
    startTime.setHours(hours, minutes, 0, 0);

    // ★★★★★ ここからが修正箇所です ★★★★★
    const reminderData = {
      // serverId をこのオブジェクトに追加します
      serverId: serverId,
      message: '今日の予定\n{{all}}',
      channel: channelName,
      channelId: channelId,
      startTime: startTime.toISOString(),
      recurrence: { type: 'daily' as const },
      status: 'active' as const,
      notificationOffsets: [0],
      selectedEmojis: [],
      hideNextTime: false,
    };

    // これで calculateNextNotificationInfo に渡すオブジェクトに serverId が含まれます
    const { nextNotificationTime, nextOffsetIndex } = calculateNextNotificationInfo(reminderData, new Date());

    const newReminderData = {
      ...reminderData,
      // serverIdは↑で追加済みなので、ここではcreatedByを追加するだけでOK
      createdBy: req.user.id,
      nextNotificationTime: nextNotificationTime,
      nextOffsetIndex: nextOffsetIndex,
    };
    // ★★★★★ ここまで ★★★★★

    const docRef = await remindersCollection.add(newReminderData);
    const result = { id: docRef.id, ...newReminderData };

    await addLogWithTrim({
      user: req.user.username,
      action: '作成 (今日の予定)',
      reminderMessage: result.message,
      after: result,
      serverId: serverId,
    });

    res.status(201).json(result);
  } catch (error) {
    console.error("Failed to create daily summary reminder:", error);
    res.status(500).json({ error: 'Failed to create daily summary reminder' });
  }
});

export default router;