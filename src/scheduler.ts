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


/**
 * 【表示用】次のサイクルの最初の通知時刻を計算する
 */
const calculateNextCycleStartTimeForDisplay = (reminder: Reminder): Date | null => {
  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return null;

  const offsets = reminder.notificationOffsets || [0];
  const currentOffsetIndex = reminder.nextOffsetIndex || 0;

  // 現在トリガーされている通知のサイクル基点時刻を計算する
  const currentCycleBaseTime = new Date((reminder.nextNotificationTime as any).toDate().getTime() + offsets[currentOffsetIndex] * 60 * 1000);

  let nextCycleStartTime: Date | null = null;

  switch (reminder.recurrence.type) {
    case 'none':
      return null;

    case 'daily': {
      let nextDate = new Date(currentCycleBaseTime);
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
      nextCycleStartTime = nextDate;
      break;
    }

    case 'interval': {
      let nextDate = new Date(currentCycleBaseTime);
      nextDate.setHours(nextDate.getHours() + reminder.recurrence.hours);
      nextCycleStartTime = nextDate;
      break;
    }

    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set(reminder.recurrence.days.map(day => dayMap[day]));
      if (targetDaysOfWeek.size === 0) return null;

      let nextDate = new Date(currentCycleBaseTime);
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);

      for (let i = 0; i < 7; i++) {
        if (targetDaysOfWeek.has(nextDate.getDay())) {
          nextCycleStartTime = nextDate;
          break;
        }
        nextDate.setDate(nextDate.getDate() + 1);
      }
      break;
    }
  }

  // 次のサイクルが見つかった場合、その最初のオフセットを適用した時刻を返す
  if (nextCycleStartTime) {
    const firstOffset = offsets[0] || 0;
    return new Date(nextCycleStartTime.getTime() - firstOffset * 60 * 1000);
  }

  return null;
};


/**
 * 【スケジューラー用】次にDBに保存すべき通知情報を計算する
 */
// ★★★★★ ここからが修正箇所です ★★★★★
const calculateNextNotificationAfterSend = (
  reminder: Reminder
): { nextNotificationTime: Date | null; nextOffsetIndex: number | null; newStartTime: string | null } => {

  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return { nextNotificationTime: null, nextOffsetIndex: null, newStartTime: null };

  const offsets = reminder.notificationOffsets || [0];
  const currentOffsetIndex = reminder.nextOffsetIndex || 0;

  // --- 同じサイクル内で、次のオフセット通知があるかチェック ---
  const nextOffsetIndexInCycle = currentOffsetIndex + 1;
  if (nextOffsetIndexInCycle < offsets.length) {
    // 現在の通知のサイクル基点時刻を計算
    const currentCycleBaseTime = new Date((reminder.nextNotificationTime as any).toDate().getTime() + offsets[currentOffsetIndex] * 60 * 1000);
    const nextOffset = offsets[nextOffsetIndexInCycle];
    const nextNotificationTime = new Date(currentCycleBaseTime.getTime() - nextOffset * 60 * 1000);

    return {
      nextNotificationTime,
      nextOffsetIndex: nextOffsetIndexInCycle,
      newStartTime: null, // サイクルが完了していないので基準日時は更新しない
    };
  }

  // --- 次のサイクルの最初の通知を計算 ---
  let nextCycleTime: Date | null = null;
  // 完了したサイクルの基準時刻を計算（これが新しいstartTimeになる）
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

  // 繰り返しがない、または次のサイクルが見つからない場合
  if (!nextCycleTime) {
    return { nextNotificationTime: null, nextOffsetIndex: null, newStartTime: null };
  }

  const firstOffset = offsets[0];
  const nextNotificationTime = new Date(nextCycleTime.getTime() - firstOffset * 60 * 1000);

  return {
    nextNotificationTime,
    nextOffsetIndex: 0,
    newStartTime: lastCycleTime.toISOString(), // 完了したサイクルの時刻を新しい基準日時として返す
  };
};
// ★★★★★ ここまで ★★★★★

const sendMessage = async (reminder: Reminder, correctedNow: Date) => {
  try {
    const channel = await client.channels.fetch(reminder.channelId);
    if (channel && channel instanceof TextChannel) {

      let finalMessage = sanitizeMessage(reminder.message);

      if (finalMessage.includes('{{all}}')) {
        const twentyFourHoursLater = new Date(correctedNow.getTime() + 24 * 60 * 60 * 1000);

        const snapshot = await remindersCollection
          .where('serverId', '==', reminder.serverId)
          .where('status', '==', 'active')
          .where('nextNotificationTime', '>=', correctedNow)
          .where('nextNotificationTime', '<=', twentyFourHoursLater)
          .orderBy('nextNotificationTime', 'asc')
          .get();

        const upcomingNotifications = snapshot.docs
          .map(doc => ({ id: doc.id, ...doc.data() } as Reminder))
          .filter(r => r.id !== reminder.id && !r.message.includes('{{all}}'));

        const groupedByEvent = new Map<string, { message: string, time: Date, offsets: number[] }>();

        for (const r of upcomingNotifications) {
          const offsets = r.notificationOffsets || [0];
          const currentOffset = offsets[r.nextOffsetIndex || 0];
          const baseCycleTime = new Date((r.nextNotificationTime as any).toDate().getTime() + currentOffset * 60 * 1000);
          const key = r.message + baseCycleTime.toISOString();

          if (!groupedByEvent.has(key)) {
            const allOffsets = (r.notificationOffsets || []).filter(offset => offset > 0);
            groupedByEvent.set(key, {
              message: r.message.split('\n')[0],
              time: baseCycleTime,
              offsets: allOffsets,
            });
          }
        }

        let scheduleList = "24時間以内に予定されているリマインダーはありません。";
        const events = Array.from(groupedByEvent.values()).sort((a, b) => a.time.getTime() - b.time.getTime());

        if (events.length > 0) {
          scheduleList = events.map(event => {
            const time = event.time.toLocaleTimeString('ja-JP', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Asia/Tokyo'
            });
            let offsetLabel = '';
            if (event.offsets.length > 0) {
              const sortedOffsets = event.offsets.sort((a, b) => b - a);
              offsetLabel = `【${sortedOffsets.join(',')}分前通知】`;
            }
            const eventMessage = event.message.replace(/\{\{\s*offset\s*\}\}/g, '').trim();
            return `\`${time}\` - ${eventMessage}${offsetLabel}`;
          }).join('\n');
        }

        finalMessage = finalMessage.replace('{{all}}', `\n**--- 24時間以内の予定 ---**\n${scheduleList}`);

      } else if (finalMessage.includes('{{offset}}')) {
        const offsets = reminder.notificationOffsets || [0];
        const currentOffset = offsets[reminder.nextOffsetIndex || 0];
        if (currentOffset > 0) {
          finalMessage = finalMessage.replace('{{offset}}', `まであと ${currentOffset} 分`);
        } else {
          finalMessage = finalMessage.replace('{{offset}}', 'の時間です！');
        }
      } else {
        const offsets = reminder.notificationOffsets || [0];
        const currentOffset = offsets[reminder.nextOffsetIndex || 0];
        if (currentOffset > 0) {
          finalMessage += `\n（${currentOffset}分前）`;
        }
      }

      const offsets = reminder.notificationOffsets || [0];
      const currentOffset = offsets[reminder.nextOffsetIndex || 0];

      const isMainNotification = currentOffset === 0;

      if (isMainNotification && reminder.hideNextTime !== true) {
        const nextTimeForDisplay = calculateNextCycleStartTimeForDisplay(reminder);
        if (nextTimeForDisplay) {
          const formatter = new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
            hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo'
          });
          const formattedDate = formatter.format(nextTimeForDisplay);
          finalMessage += `\n\n次の通知: ${formattedDate}`;
        }
      }

      if (!finalMessage || !finalMessage.trim()) {
        console.error(`[Scheduler] Error: Attempted to send an empty message for reminder ID ${reminder.id}. Aborting.`);
        return;
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

    for (const doc of snapshot.docs) {
      const reminderId = doc.id;
      const reminderRef = remindersCollection.doc(reminderId);

      try {
        await db.runTransaction(async (transaction) => {
          const freshDoc = await transaction.get(reminderRef);
          if (!freshDoc.exists) return;

          const reminderData = freshDoc.data() as Reminder;

          if (reminderData.status !== 'active') {
            console.log(`[Scheduler] Reminder ${reminderId} is already being processed or is paused. Skipping.`);
            return;
          }

          transaction.update(reminderRef, { status: 'processing' });
        });
      } catch (error) {
        console.warn(`[Scheduler] Race condition detected for reminder ${reminderId}. Another instance won. Skipping.`);
        continue;
      }

      console.log(`[Scheduler] Acquired lock for reminder ${reminderId}.`);

      const reminder = { id: reminderId, ...doc.data() } as Reminder;

      const notificationTime = (reminder.nextNotificationTime as any).toDate();
      const missedBy = correctedNow.getTime() - notificationTime.getTime();

      if (missedBy < GRACE_PERIOD) {
        await sendMessage(reminder, correctedNow);
      } else {
        console.warn(`[Scheduler] SKIPPED reminder "${reminder.message}" (too late)`);
        await missedNotificationsCollection.add({
          serverId: reminder.serverId,
          reminderMessage: reminder.message,
          missedAt: reminder.nextNotificationTime,
          channelName: reminder.channel,
          acknowledged: false,
        });
      }

      // ★★★★★ ここからが修正箇所です ★★★★★
      const { nextNotificationTime, nextOffsetIndex, newStartTime } = calculateNextNotificationAfterSend(reminder);

      const updatePayload: { [key: string]: any } = {};

      if (nextNotificationTime) {
        updatePayload.nextNotificationTime = nextNotificationTime;
        updatePayload.nextOffsetIndex = nextOffsetIndex;
        updatePayload.status = 'active';
        if (newStartTime) {
          updatePayload.startTime = newStartTime;
        }
      } else {
        updatePayload.nextNotificationTime = null;
        updatePayload.nextOffsetIndex = null;
        updatePayload.status = 'paused';
      }

      await reminderRef.update(updatePayload);
      // ★★★★★ ここまで ★★★★★
      console.log(`[Scheduler] Processed and released lock for reminder ${reminderId}.`);
    }

  } catch (error) {
    console.error('[Scheduler] Error during reminder check:', error);
  } finally {
    isChecking = false;
  }
};