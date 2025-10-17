/// <reference path="./types/ntp-client.d.ts" />
import { db } from './config/firebase';
import { client } from './index';
import { TextChannel } from 'discord.js';
import { Reminder } from './types';
import ntpClient from 'ntp-client';

const remindersCollection = db.collection('reminders');
const missedNotificationsCollection = db.collection('missedNotifications');
const GRACE_PERIOD = 10 * 60 * 1000; // 10分

// サーバー時刻とNTP時刻の差（ミリ秒）を保持する変数
let clockOffsetMs = 0;
// 最後にNTPと同期した時刻（Unixタイムスタンプ）を保持する変数
let lastSyncTime: number = 0;

// 同期の条件を定義
const SIX_HOURS_MS = 6 * 60 * 60 * 1000; // 6時間
const FIVE_MINUTES_MS = 5 * 60 * 1000;   // 5分

/**
 * NTPサーバーに問い合わせ、サーバー時刻とのズレを計算して clockOffsetMs を更新する
 */
export const synchronizeClock = async () => {
  try {
    const ntpDate = await new Promise<Date>((resolve, reject) => {
      // 信頼性の高いNISTのNTPサーバーを使用
      ntpClient.getNetworkTime("time.nist.gov", 123, (err: Error | null, date: Date) => {
        if (err) return reject(err);
        resolve(date);
      });
    });
    const localDate = new Date();
    clockOffsetMs = ntpDate.getTime() - localDate.getTime();
    // 最後に同期した時刻を記録
    lastSyncTime = localDate.getTime();
    console.log(`[Clock Sync] Time synchronized. Offset is ${clockOffsetMs}ms.`);
  } catch (error) {
    console.error("[Clock Sync] Failed to synchronize with NTP server:", error);
    clockOffsetMs = 0;
  }
};

/**
 * 補正された現在時刻を取得する
 * @returns {Date} サーバーのローカル時刻にオフセットを適用した、より正確な時刻
 */
const getCorrectedDate = (): Date => {
  const localDate = new Date();
  return new Date(localDate.getTime() + clockOffsetMs);
};

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
      const baseTimeMillis = lastNotificationTime.getTime();
      const intervalMillis = reminder.recurrence.hours * 60 * 60 * 1000;
      return new Date(baseTimeMillis + intervalMillis);
    }
    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));
      if (targetDaysOfWeek.size === 0) return null;

      let nextDate = new Date(lastNotificationTime);
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          return nextDate;
        }
        nextDate.setDate(nextDate.getDate() + 1);
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

  try {
    const nowForSyncCheck = new Date();
    let shouldSync = false;

    // 条件1：最後の同期から6時間以上経過したか？
    if (nowForSyncCheck.getTime() - lastSyncTime > SIX_HOURS_MS) {
      console.log('[Clock Sync] Triggering sync due to long interval.');
      shouldSync = true;
    }

    // 条件2：通知が5分以内に迫っているか？
    if (!shouldSync) {
      const nextReminderSnapshot = await remindersCollection
        .where('status', '==', 'active')
        .orderBy('nextNotificationTime', 'asc')
        .limit(1)
        .get();

      if (!nextReminderSnapshot.empty) {
        const nextReminder = nextReminderSnapshot.docs[0].data() as Reminder;
        if (nextReminder.nextNotificationTime) {
          const nextTime = (nextReminder.nextNotificationTime as any).toDate().getTime();
          if (nextTime - nowForSyncCheck.getTime() < FIVE_MINUTES_MS) {
            console.log('[Clock Sync] Triggering sync because a reminder is approaching.');
            shouldSync = true;
          }
        }
      }
    }

    // いずれかの条件を満たした場合のみ、NTPにアクセスする
    if (shouldSync) {
      await synchronizeClock();
    }

    // 補正された時刻を使って、本来の処理を行う
    const correctedNow = getCorrectedDate();
    const snapshot = await remindersCollection
      .where('status', '==', 'active')
      .where('nextNotificationTime', '<=', correctedNow)
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

      const missedBy = correctedNow.getTime() - notificationTime.getTime();

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