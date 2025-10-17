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

// ★★★★★ ここからが修正箇所です ★★★★★
const calculateNextOccurrence = (reminder: Omit<Reminder, 'id' | 'createdBy' | 'channel' | 'message' | 'status'>, baseTime: Date): Date | null => {
  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return null;

  switch (reminder.recurrence.type) {
    case 'none':
      // 基準時刻より後であれば、その日時を返す
      return startDate >= baseTime ? startDate : null;

    case 'interval': {
      // 基準時刻を越えるまで、開始時刻から間隔を足し続ける
      let nextDate = new Date(startDate);
      while (nextDate <= baseTime) {
        nextDate.setHours(nextDate.getHours() + reminder.recurrence.hours);
      }
      return nextDate;
    }
    
    case 'daily': {
      // 検索開始日時（今 or 起点日）
      let nextDate = baseTime > startDate ? new Date(baseTime) : new Date(startDate);
      // 起点日の時刻をセット
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

      // もし今日の予定時刻がすでに過ぎていたら、明日へ
      if (nextDate <= baseTime) {
        nextDate.setDate(nextDate.getDate() + 1);
      }
      return nextDate;
    }

    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));

      if (targetDaysOfWeek.size === 0) return null;

      // 検索開始日時を設定（基準時刻より過去にはならないように）
      let nextDate = baseTime > startDate ? new Date(baseTime) : new Date(startDate);

      // ユーザーが指定した「時刻」をnextDateにセットする
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

      // もし計算した今日の予定時刻がすでに過ぎていたら、検索開始を明日にする
      if (nextDate <= baseTime) {
        nextDate.setDate(nextDate.getDate() + 1);
      }

      // 最大7日間（1週間）ループして、次の該当日を探す
      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          // 該当日が見つかったので、その日付を返す
          return nextDate;
        }
        // 次の日に移動
        nextDate.setDate(nextDate.getDate() + 1);
      }
      // 1週間探しても見つからなかった（＝曜日が指定されていないなど）
      return null;
    }
  }
  return null;
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

router.post('/:serverId', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const { userId, ...reminderData } = req.body;

    const nextNotificationTime = calculateNextOccurrence(reminderData as any, new Date());
    const newReminderData = {
      ...reminderData,
      serverId: serverId,
      createdBy: req.user.id,
      nextNotificationTime: nextNotificationTime,
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

router.put('/:id', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const updatedData = {
      ...req.body,
      selectedEmojis: req.body.selectedEmojis || [],
    };
    const docRef = remindersCollection.doc(id);
    const beforeSnap = await docRef.get();
    const beforeData = beforeSnap.data();

    if (!beforeData) {
      return res.status(404).json({ error: "Reminder not found." });
    }

    const nextNotificationTime = calculateNextOccurrence(updatedData as any, new Date());
    await docRef.update({ ...updatedData, nextNotificationTime });

    await addLogWithTrim({
      user: req.user.username,
      action: '更新',
      reminderMessage: updatedData.message,
      before: { id, ...beforeData },
      after: { id, ...updatedData },
      serverId: beforeData.serverId,
    });

    res.status(200).json({ id, ...updatedData, nextNotificationTime });
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

export default router;