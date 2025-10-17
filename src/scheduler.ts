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
      let finalMessage = sanitizeMessage(reminder.message);

      // hideNextTimeフラグがtrueでない場合、次の通知日時を計算して追記する
      // (フラグがない古いリマインダーはデフォルトで日時を表示する)
      if (reminder.hideNextTime !== true) {

        // ★★★ 修正箇所 ★★★
        // 次の通知時刻を計算するために「今」の時刻が必要
        const correctedNow = getCorrectedDate();
        const nextOccurrence = calculateNextOccurrenceAfterSend(reminder, (reminder.nextNotificationTime as any).toDate(), correctedNow);
        // ★★★ ここまで ★★★

        if (nextOccurrence) {
          // "2025年10月18日 土曜日 12:20" の形式にフォーマット
          const formatter = new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Tokyo'
          });
          const formattedDate = formatter.format(nextOccurrence);

          finalMessage += `\n\nリマインド予定日時: ${formattedDate}`;
        }
      }

      const sentMessage = await channel.send(finalMessage);
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

// ★★★ 修正箇所 (シグネチャに correctedNow: Date を追加) ★★★
const calculateNextOccurrenceAfterSend = (reminder: Reminder, lastNotificationTime: Date, correctedNow: Date): Date | null => {
  // ★ 起点日(startTime)をアンカー（基準）として使用する
  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return null;

  switch (reminder.recurrence.type) {
    case 'none':
      return null;

    case 'interval': {
      // ★★★ 修正箇所 (カスケード問題の修正) ★★★
      //「今」(correctedNow) の時刻を基準に、
      //「起点日」(startDate) から「間隔」(intervalHours) を足していき、
      //「今」を超える次の実行時刻スロットを探す

      let nextDate = new Date(startDate);
      const intervalHours = reminder.recurrence.hours;

      //「今」を超えるまでループ
      while (nextDate <= correctedNow) {
        nextDate.setHours(nextDate.getHours() + intervalHours);
      }
      return nextDate;
      // ★★★ ここまで ★★★
    }

    case 'daily': {
      // 最後に実行されるはずだった時刻 (lastNotificationTime) を基準
      let nextDate = new Date(lastNotificationTime);
      // 翌日に設定
      nextDate.setDate(nextDate.getDate() + 1);
      // 時刻は「起点日」のものを利用
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
      return nextDate;
    }

    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));
      if (targetDaysOfWeek.size === 0) return null;

      // 週次の場合は、最後に実行されるはずだった時刻 (lastNotificationTime) を基準に次を探す
      let nextDate = new Date(lastNotificationTime);
      nextDate.setDate(nextDate.getDate() + 1);
      // 時刻は「起点日」のものを利用
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

      // ★★★ 修正箇所 (correctedNow を渡す) ★★★
      const nextTime = calculateNextOccurrenceAfterSend(reminder, notificationTime, correctedNow);

      if (nextTime) {
        // ★★★ 修正箇所 ★★★
        // ご提案の「起点日を移動させる」処理
        // interval の場合、起点日(startTime)も「実行されるはずだった時刻」に更新し、
        // 次の編集時に備える
        if (reminder.recurrence.type === 'interval') {
          await doc.ref.update({
            nextNotificationTime: nextTime,
            startTime: notificationTime // ★ 起点日を、実行された（or スキップされた）「予定時刻」に更新
          });
        } else {
          await doc.ref.update({ nextNotificationTime: nextTime });
        }
        // ★★★ ここまで ★★★
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