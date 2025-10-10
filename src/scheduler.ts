import { db } from './config/firebase';
import { client } from './index';
import { TextChannel } from 'discord.js';
import { Reminder } from './types';
import { FieldValue } from 'firebase-admin/firestore';

const remindersCollection = db.collection('reminders');
const missedNotificationsCollection = db.collection('missedNotifications');
const GRACE_PERIOD = 10 * 60 * 1000;

const cleanupStalePendingUsers = async () => {
  console.log('[Scheduler] Running cleanup for stale pending users...');
  const threshold = new Date();
  threshold.setHours(threshold.getHours() - 24);

  try {
    const staleUsersSnapshot = await db.collection('users')
      .where('subscriptionStatus', '==', 'pending')
      .where('pendingSince', '<', threshold)
      .get();

    if (staleUsersSnapshot.empty) {
      console.log('[Scheduler] No stale pending users found.');
      return;
    }

    console.log(`[Scheduler] Found ${staleUsersSnapshot.size} stale pending user(s). Reverting to 'inactive'.`);

    const batch = db.batch();
    staleUsersSnapshot.forEach(doc => {
      batch.update(doc.ref, { 
        subscriptionStatus: 'inactive',
        pendingSince: FieldValue.delete(),
      });
    });

    await batch.commit();
    console.log('[Scheduler] Cleanup of stale pending users finished successfully.');

  } catch (error) {
    console.error('[Scheduler] Error during cleanup of stale pending users:', error);
  }
}

const sanitizeMessage = (message: string): string => {
  return message
    .replace(/@everyone/g, '＠everyone')
    .replace(/@here/g, '＠here')
    .replace(/<@&(\d+)>/g, '＠ロール')
    .replace(/<@!?(\d+)>/g, '＠ユーザー');
};

const sendMessage = async (reminder: Reminder) => {
  try {
    const channel = await client.channels.fetch(reminder.channelId);
    if (channel && channel instanceof TextChannel) {
      const safeMessage = sanitizeMessage(reminder.message);
      const sentMessage = await channel.send(safeMessage);
      console.log(`[Scheduler] Sent reminder "${reminder.message}" to #${channel.name}`);

      if (reminder.selectedEmojis && reminder.selectedEmojis.length > 0) {
        for (const emojiId of reminder.selectedEmojis) {
          try {
            await sentMessage.react(emojiId);
          } catch (reactError) {
            console.warn(`[Scheduler] Failed to react with emoji ${emojiId} for reminder ${reminder.id}.`);
          }
        }
      }
    } else {
      console.warn(`[Scheduler] Channel not found for reminder ID: ${reminder.id}`);
    }
  } catch (error) {
    console.error(`[Scheduler] Failed to send message for reminder ${reminder.id}:`, error);
  }
}

const calculateNextOccurrenceAfterSend = (reminder: Reminder, lastNotificationTime: Date): Date | null => {
  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return null;

  switch (reminder.recurrence.type) {
    case 'none':
      return null;
    case 'interval': {
      let nextIntervalDate = new Date(lastNotificationTime);
      nextIntervalDate.setHours(nextIntervalDate.getHours() + reminder.recurrence.hours);
      return nextIntervalDate;
    }
    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));
      if (targetDaysOfWeek.size === 0) return null;
      let nextDate = new Date(lastNotificationTime);
      nextDate.setDate(nextDate.getDate() + 1);
      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          let finalDate = new Date(nextDate);
          finalDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
          return finalDate;
        }
        nextDate.setDate(nextDate.getDate() + 1);
      }
    }
  }
  return null;
};

let isChecking = false;

export const checkAndSendReminders = async () => {
  if (isChecking) {
    console.log(`[Scheduler] Skip: Previous check is still running.`);
    return;
  }
  isChecking = true;
  console.log(`[Scheduler] Checking for due reminders at ${new Date().toLocaleTimeString('ja-JP')}`);
  
  await cleanupStalePendingUsers();

  const now = new Date();

  try {
    const snapshot = await remindersCollection
      .where('status', '==', 'active')
      .where('nextNotificationTime', '<=', now)
      .get();

    if (snapshot.empty) {
      isChecking = false;
      return;
    }

    console.log(`[Scheduler] Found ${snapshot.size} due reminder(s).`);

    const promises = snapshot.docs.map(async (doc) => {
      const reminder = { id: doc.id, ...doc.data() } as Reminder;
      const notificationTime = reminder.nextNotificationTime.toDate();
      const missedBy = now.getTime() - notificationTime.getTime();

      if (missedBy < GRACE_PERIOD) {
        await sendMessage(reminder);
      } else {
        console.warn(`[Scheduler] SKIPPED reminder "${reminder.message}" (too late)`);
        await missedNotificationsCollection.add({
          serverId: reminder.serverId,
          reminderMessage: reminder.message,
          missedAt: reminder.nextNotificationTime,
          channelName: reminder.channel,
          acknowledged: false,
        });

        const logsSnapshot = await missedNotificationsCollection
          .where('serverId', '==', reminder.serverId)
          .orderBy('missedAt', 'desc')
          .get();
        if (logsSnapshot.size > 10) {
          const surplus = logsSnapshot.size - 10;
          for (let i = 0; i < surplus; i++) {
            await logsSnapshot.docs[logsSnapshot.size - 1 - i].ref.delete();
          }
        }
      }

      const nextTime = calculateNextOccurrenceAfterSend(reminder, notificationTime);

      if (nextTime) {
        await doc.ref.update({ nextNotificationTime: nextTime });
      } else {
        await doc.ref.update({ status: 'paused', nextNotificationTime: null });
      }
    });

    await Promise.all(promises);

  } catch (error) {
    console.error('[Scheduler] Error during reminder check:', error);
  } finally {
    isChecking = false;
  }
};