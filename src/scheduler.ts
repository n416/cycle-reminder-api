import { db } from './config/firebase';
import { client } from './index';
import { TextChannel } from 'discord.js';
import { Reminder } from './types';

const remindersCollection = db.collection('reminders');
const missedNotificationsCollection = db.collection('missedNotifications');
const GRACE_PERIOD = 10 * 60 * 1000; // 10分

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
      // 基準となる時刻（前回の通知時刻）のミリ秒表現を取得
      const baseTimeMillis = lastNotificationTime.getTime();
      // インターバル時間（時間単位）をミリ秒に変換
      const intervalMillis = reminder.recurrence.hours * 60 * 60 * 1000;
      // 次の通知時刻をミリ秒で計算し、新しいDateオブジェクトを返す
      return new Date(baseTimeMillis + intervalMillis);
    }
    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));
      if (targetDaysOfWeek.size === 0) return null;

      // 前回の通知日の翌日から検索を開始
      let nextDate = new Date(lastNotificationTime);
      nextDate.setDate(nextDate.getDate() + 1);

      // 時刻を、ユーザーが最初に指定した時刻に固定する
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

      // 最大7日間ループして、次の該当日を探す
      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          return nextDate; // 該当日が見つかったら、その日付を返す
        }
        nextDate.setDate(nextDate.getDate() + 1); // 次の日に移動
      }
      return null;
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
  // console.log(`[Scheduler] Checking for due reminders at ${new Date().toLocaleTimeString('ja-JP')}`);

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
      
      if (!reminder.nextNotificationTime || typeof reminder.nextNotificationTime.toDate !== 'function') {
        console.error(`[Scheduler] Invalid nextNotificationTime for reminder ID: ${reminder.id}. Skipping and pausing.`);
        await doc.ref.update({ status: 'paused', nextNotificationTime: null });
        return;
      }
      
      const notificationTime = reminder.nextNotificationTime.toDate();
      
      if (isNaN(notificationTime.getTime())) {
          console.error(`[Scheduler] Parsed date is invalid for reminder ID: ${reminder.id}. Skipping and pausing.`);
          await doc.ref.update({ status: 'paused', nextNotificationTime: null });
          return;
      }

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

        const logsSnapshot = await missedNotificationsCollection.where('serverId', '==', reminder.serverId).orderBy('missedAt', 'desc').get();
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