/// <reference path="./types/ntp-client.d.ts" />
import { db } from './config/firebase';
import { client } from './index';
import { TextChannel } from 'discord.js';
import { Reminder } from './types';
import ntpClient from 'ntp-client';

const remindersCollection = db.collection('reminders');
const missedNotificationsCollection = db.collection('missedNotifications');
const GRACE_PERIOD = 10 * 60 * 1000; // 10分

let clockOffsetMs = 0;
let lastSyncTime: number = 0;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

export const synchronizeClock = async () => {
  try {
    const ntpDate = await new Promise<Date>((resolve, reject) => {
      ntpClient.getNetworkTime("time.nist.gov", 123, (err: Error | null, date: Date) => {
        if (err) return reject(err);
        resolve(date);
      });
    });
    const localDate = new Date();
    clockOffsetMs = ntpDate.getTime() - localDate.getTime();
    lastSyncTime = localDate.getTime();
    console.log(`[Clock Sync] Time synchronized. Offset is ${clockOffsetMs}ms.`);
  } catch (error) {
    console.error("[Clock Sync] Failed to synchronize with NTP server:", error);
    clockOffsetMs = 0;
  }
};

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

const calculateNextNotificationAfterSend = (
  reminder: Reminder
): { nextNotificationTime: Date | null; nextOffsetIndex: number | null } => {

  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return { nextNotificationTime: null, nextOffsetIndex: null };

  const offsets = reminder.notificationOffsets || [0];
  const currentOffsetIndex = reminder.nextOffsetIndex || 0;

  const nextOffsetIndexInCycle = currentOffsetIndex + 1;
  if (nextOffsetIndexInCycle < offsets.length) {
    const lastCycleTime = new Date((reminder.nextNotificationTime as any).toDate().getTime() + offsets[currentOffsetIndex] * 60 * 1000);
    const nextOffset = offsets[nextOffsetIndexInCycle];
    const nextNotificationTime = new Date(lastCycleTime.getTime() - nextOffset * 60 * 1000);
    
    return {
      nextNotificationTime,
      nextOffsetIndex: nextOffsetIndexInCycle,
    };
  }

  let nextCycleTime: Date | null = null;
  const lastCycleTime = new Date((reminder.nextNotificationTime as any).toDate().getTime() + offsets[currentOffsetIndex] * 60 * 1000);

  switch (reminder.recurrence.type) {
    case 'none':
      nextCycleTime = null;
      break;
    case 'daily': {
      let nextDate = new Date(lastCycleTime);
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
      nextCycleTime = nextDate;
      break;
    }
    case 'interval': {
      let nextDate = new Date(lastCycleTime);
      nextDate.setHours(nextDate.getHours() + reminder.recurrence.hours);
      nextCycleTime = nextDate;
      break;
    }
    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));
      if (targetDaysOfWeek.size === 0) {
        nextCycleTime = null;
        break;
      }
      let nextDate = new Date(lastCycleTime);
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          nextCycleTime = nextDate;
          break;
        }
        nextDate.setDate(nextDate.getDate() + 1);
      }
      break;
    }
  }

  if (!nextCycleTime) {
    return { nextNotificationTime: null, nextOffsetIndex: null };
  }

  const firstOffset = offsets[0];
  const nextNotificationTime = new Date(nextCycleTime.getTime() - firstOffset * 60 * 1000);
  
  return {
    nextNotificationTime,
    nextOffsetIndex: 0,
  };
};

// ★★★★★ ここからが修正箇所です (sendMessage にデバッグログを追加) ★★★★★
const sendMessage = async (reminder: Reminder) => {
  // --- デバッグログ ---
  console.log(`\n--- [SEND DEBUG] sendMessage が呼び出されました (ID: ${reminder.id}) ---`);

  try {
    const channel = await client.channels.fetch(reminder.channelId);
    if (channel && channel instanceof TextChannel) {
      
      const offsets = reminder.notificationOffsets || [0];
      const currentOffset = offsets[reminder.nextOffsetIndex || 0];
      console.log(`[SEND DEBUG] 1. DBから取得した生のメッセージ: "${reminder.message}"`);
      console.log(`[SEND DEBUG] 2. 現在のオフセット値: ${currentOffset} 分前`);

      let finalMessage = sanitizeMessage(reminder.message);
      console.log(`[SEND DEBUG] 3. sanitizeMessage後のメッセージ: "${finalMessage}"`);
      
      if (finalMessage.includes('{{offset}}')) {
        console.log("[SEND DEBUG] 4. '{{offset}}' が見つかりました。置換処理を実行します。");
        if (currentOffset > 0) {
          finalMessage = finalMessage.replace('{{offset}}', `まであと ${currentOffset} 分`);
          console.log(`[SEND DEBUG] 5a. (N分前) 置換後のメッセージ: "${finalMessage}"`);
        } else {
          finalMessage = finalMessage.replace('{{offset}}', 'の時間です！');
          console.log(`[SEND DEBUG] 5b. (時間丁度) 置換後のメッセージ: "${finalMessage}"`);
        }
      } else {
        console.log("[SEND DEBUG] 4. '{{offset}}' が見つかりませんでした。追記処理を実行します。");
        if (currentOffset > 0) {
          finalMessage += `\n（${currentOffset}分前）`;
          console.log(`[SEND DEBUG] 5c. (追記) 後のメッセージ: "${finalMessage}"`);
        }
      }

      if (reminder.hideNextTime !== true) {
        const { nextNotificationTime: nextTimeForDisplay } = calculateNextNotificationAfterSend(reminder);
        if (nextTimeForDisplay) {
          const formatter = new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
            hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo'
          });
          const formattedDate = formatter.format(nextTimeForDisplay);
          finalMessage += `\n\n次の通知: ${formattedDate}`;
        }
      }

      console.log(`[SEND DEBUG] 6. Discordに送信する最終的なメッセージ: "${finalMessage}"`);
      if (!finalMessage || !finalMessage.trim()) {
          console.error("[SEND DEBUG] !!! エラー: 最終的なメッセージが空または空白です。送信を中止します。 !!!");
          return; // 空メッセージの送信を防止
      }

      const sentMessage = await channel.send(finalMessage);
      console.log(`[SEND DEBUG] 7. メッセージは正常に送信されました。`);

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
    console.error(`[SEND DEBUG] !!! sendMessageの実行中にエラーが発生しました !!!`, error);
  }
}

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
    if (nowForSyncCheck.getTime() - lastSyncTime > SIX_HOURS_MS) {
      shouldSync = true;
    }
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
            shouldSync = true;
          }
        }
      }
    }
    if (shouldSync) {
      await synchronizeClock();
    }

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
      const notificationTime = (reminder.nextNotificationTime as any).toDate();
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
      }

      const { nextNotificationTime, nextOffsetIndex } = calculateNextNotificationAfterSend(reminder);

      if (nextNotificationTime) {
        const updateData: {
          nextNotificationTime: Date;
          nextOffsetIndex: number | null;
          startTime?: string;
        } = {
          nextNotificationTime,
          nextOffsetIndex,
        };
        
        if (reminder.recurrence.type === 'interval') {
          updateData.startTime = notificationTime.toISOString();
        }

        await doc.ref.update(updateData);

      } else {
        await doc.ref.update({ status: 'paused', nextNotificationTime: null, nextOffsetIndex: null });
      }
    });

    await Promise.all(promises);

  } catch (error) {
    console.error('[Scheduler] Error during reminder check:', error);
  } finally {
    isChecking = false;
  }
};