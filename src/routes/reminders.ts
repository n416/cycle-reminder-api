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

const calculateNextOccurrence = (reminder: Omit<Reminder, 'id' | 'createdBy' | 'channel' | 'message' | 'status'>, baseTime: Date): Date | null => {
    const startDate = new Date(reminder.startTime);
    if (isNaN(startDate.getTime())) return null;
  
    switch (reminder.recurrence.type) {
      case 'none':
        return startDate >= baseTime ? startDate : null;
  
      case 'interval': {
        let nextIntervalDate = new Date(startDate);
        while (nextIntervalDate <= baseTime) {
          nextIntervalDate.setHours(nextIntervalDate.getHours() + reminder.recurrence.hours);
        }
        return nextIntervalDate;
      }
  
      case 'weekly': {
        const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
        const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));

        if (targetDaysOfWeek.size === 0) return null;
  
        let nextDate = new Date(baseTime);
        nextDate.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds(), 0);

        if (nextDate <= baseTime) {
            nextDate.setDate(nextDate.getDate() + 1);
        }
        
        for (let i = 0; i < 7; i++) {
            if (targetDaysOfWeek.has(nextDate.getDay())) {
                let finalDate = new Date(nextDate);
                finalDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
                if(finalDate < startDate) {
                    nextDate.setDate(nextDate.getDate() + 1);
                    continue;
                };
                return finalDate;
            }
            nextDate.setDate(nextDate.getDate() + 1);
        }
      }
    }
    return null;
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
    const updatedData = req.body;
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

// --- ★★★ ここから修正 ★★★ ---
const sanitizeMessage = (message: string): string => {
  return message
    .replace(/@everyone/g, '＠everyone')
    .replace(/@here/g, '＠here')
    .replace(/<@&(\d+)>/g, '＠ロール')
    .replace(/<@!?(\d+)>/g, '＠ユーザー');
};

router.post('/:serverId/test-send', protect, protectWrite, async (req: AuthRequest, res) => {
  try {
    const { channelId, message } = req.body;

    if (!channelId || !message) {
      return res.status(400).json({ message: 'channelId and message are required.' });
    }

    const channel = await client.channels.fetch(channelId);
    if (channel && channel instanceof TextChannel) {
      const testMessage = `＝＝＝テスト送信です＝＝＝\n${sanitizeMessage(message)}`;
      await channel.send(testMessage);
      res.status(200).json({ message: 'Test message sent successfully.' });
    } else {
      res.status(404).json({ message: 'Channel not found or is not a text channel.' });
    }
  } catch (error) {
    console.error("Failed to send test message:", error);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});
// --- ★★★ ここまで修正 ★★★ ---

export default router;