import { db } from './config/firebase';
import { client } from './index';
import { TextChannel } from 'discord.js';
import { Reminder } from './types';

const remindersCollection = db.collection('reminders');
const missedNotificationsCollection = db.collection('missedNotifications');
const GRACE_PERIOD = 10 * 60 * 1000;

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
            console.warn(`[Scheduler] Failed to react with emoji ${emojiId} for reminder ${reminder.id}. Emoji might be deleted.`);
          }
        }
      }

    } else {
      console.warn(`[Scheduler] Channel not found or not a text channel for reminder ID: ${reminder.id}`);
    }
  } catch (error) {
    console.error(`[Scheduler] Failed to send message for reminder ${reminder.id}:`, error);
  }
}

// ★★★★★ ここからが修正箇所です ★★★★★
const calculateNextOccurrenceAfterSend = (reminder: Reminder, lastNotificationTime: Date): Date | null => {
  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return null;

  switch (reminder.recurrence.type) {
    case 'none':
      return null;

    case 'interval': {
      let nextDate = new Date(lastNotificationTime);
      // 次の通知時刻を計算
      nextDate.setHours(nextDate.getHours() + reminder.recurrence.hours);
      return nextDate;
    }

    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));

      if (targetDaysOfWeek.size === 0) return null;

      // 検索開始を「最後に通知した日の翌日」にする
      let nextDate = new Date(lastNotificationTime);
      nextDate.setDate(nextDate.getDate() + 1);
      
      // 時刻をユーザー指定のものにリセット
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

      // 最大7日間ループして次の該当日を探す
      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          return nextDate; // 見つかった
        }
        nextDate.setDate(nextDate.getDate() + 1);
      }
      return null;
    }
  }
  return null;
};
// ★★★★★ ここまで ★★★★★

let isChecking = false;

export const checkAndSendReminders = async () => {
  if (isChecking) {
    console.log(`[Scheduler] Skip: Previous check is still running.`);
    return;
  }
  isChecking = true;
  console.log(`[Scheduler] Checking for due reminders at ${new Date().toLocaleTimeString('ja-JP')}`);

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
      
      // ★★★★★ 念のため、日付が無効な場合はここでスキップする ★★★★★
      if (!reminder.nextNotificationTime || typeof reminder.nextNotificationTime.toDate !== 'function') {
        console.error(`[Scheduler] Invalid nextNotificationTime for reminder ID: ${reminder.id}. Skipping.`);
        await doc.ref.update({ status: 'paused', nextNotificationTime: null });
        return;
      }
      const notificationTime = reminder.nextNotificationTime.toDate();
      if (isNaN(notificationTime.getTime())) {
          console.error(`[Scheduler] Parsed date is invalid for reminder ID: ${reminder.id}. Skipping.`);
          await doc.ref.update({ status: 'paused', nextNotificationTime: null });
          return;
      }
      // ★★★★★ ここまで ★★★★★

      const missedBy = now.getTime() - notificationTime.getTime();

      if (missedBy < GRACE_PERIOD) {
        await sendMessage(reminder);
      } else {
        console.warn(`[Scheduler] SKIPPED reminder "${reminder.message}" (too late by ${Math.round(missedBy / 60000)} mins)`);
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
            const oldestDoc = logsSnapshot.docs[logsSnapshot.size - 1 - i];
            await oldestDoc.ref.delete();
          }
          console.log(`[Scheduler] Trimmed ${surplus} old missed notification(s) for server ${reminder.serverId}.`);
        }
      }

      const nextTime = calculateNextOccurrenceAfterSend(reminder, notificationTime);

      if (nextTime) {
        await doc.ref.update({ nextNotificationTime: nextTime });
      } else {
        await doc.ref.update({ status: 'paused', nextNotificationTime: null });
        console.log(`[Scheduler] Reminder ${reminder.id} was a one-time event and is now paused.`);
      }
    });

    await Promise.all(promises);

  } catch (error) {
    console.error('[Scheduler] Error during reminder check:', error);
  } finally {
    isChecking = false;
  }
};