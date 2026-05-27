import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { eq, and, lte, asc, inArray, or } from 'drizzle-orm';
import { HonoEnv } from './hono';
import { formatMessageContent } from './utils/messageFormatter';
// Removed @discordjs/rest dependency

const GRACE_PERIOD = 60 * 60 * 1000; // 60分

const calculateNextNotificationAfterSend = (
  reminder: any
): { nextNotificationTime: string | null; nextOffsetIndex: number | null; newStartTime: string | null; eventTime: string | null } => {

  const startDate = new Date(reminder.startTime);
  if (isNaN(startDate.getTime())) return { nextNotificationTime: null, nextOffsetIndex: null, newStartTime: null, eventTime: null };

  let offsets = reminder.notificationOffsets || [0];
  if (typeof offsets === 'string') {
    try { offsets = JSON.parse(offsets); } catch (e) { offsets = [0]; }
  }

  const currentOffsetIndex = reminder.nextOffsetIndex || 0;

  const nextOffsetIndexInCycle = currentOffsetIndex + 1;
  if (nextOffsetIndexInCycle < offsets.length) {
    const currentCycleBaseTime = new Date(new Date(reminder.nextNotificationTime).getTime() + offsets[currentOffsetIndex] * 60 * 1000);
    const nextOffset = offsets[nextOffsetIndexInCycle];
    const nextNotificationTime = new Date(currentCycleBaseTime.getTime() - nextOffset * 60 * 1000);

    return {
      nextNotificationTime: nextNotificationTime.toISOString(),
      nextOffsetIndex: nextOffsetIndexInCycle,
      newStartTime: null,
      eventTime: currentCycleBaseTime.toISOString(),
    };
  }

  let nextCycleTime: Date | null = null;
  const lastCycleTime = new Date(new Date(reminder.nextNotificationTime).getTime() + offsets[currentOffsetIndex] * 60 * 1000);

  let recurrence = reminder.recurrence;
  if (typeof recurrence === 'string') {
    try {
      recurrence = JSON.parse(recurrence);
    } catch (e) {
      recurrence = { type: 'none' };
    }
  }

  switch (recurrence.type) {
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
      nextDate.setHours(nextDate.getHours() + recurrence.hours);
      nextCycleTime = nextDate;
      break;
    }
    case 'weekly': {
      const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDaysOfWeek = new Set((recurrence.days || []).map((day: string) => dayMap[day]));
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
    return { nextNotificationTime: null, nextOffsetIndex: null, newStartTime: null, eventTime: null };
  }

  const firstOffset = offsets[0] || 0;
  const nextNotificationTime = new Date(nextCycleTime.getTime() - firstOffset * 60 * 1000);

  return {
    nextNotificationTime: nextNotificationTime.toISOString(),
    nextOffsetIndex: 0,
    newStartTime: lastCycleTime.toISOString(),
    eventTime: nextCycleTime.toISOString(),
  };
};

const sendMessage = async (env: HonoEnv['Bindings'], reminder: any, db: ReturnType<typeof drizzle>): Promise<boolean> => {
  try {
    let offsets = reminder.notificationOffsets;
    if (typeof offsets === 'string') {
      try { offsets = JSON.parse(offsets); } catch (e) { offsets = [0]; }
    }

    let finalMessage = await formatMessageContent(db, reminder.serverId, reminder.message, {
      nextOffsetIndex: reminder.nextOffsetIndex,
      notificationOffsets: offsets
    });

    if (!finalMessage) return true;

    const isDev = env.NODE_ENV === 'development' || env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
    if (isDev && reminder.serverId === 'dev_server_1') {
      console.log(`[Scheduler] Dev Mode: Sent reminder ${reminder.id} to channel ${reminder.channelId}. Content: ${finalMessage}`);
      return true;
    }

    if (finalMessage.length > 2000) {
      finalMessage = finalMessage.substring(0, 1997) + '...';
    }

    const res = await fetch(`https://discord.com/api/v10/channels/${reminder.channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: finalMessage })
    });

    if (!res.ok) {
      throw new Error(`Discord API error: ${res.statusText}`);
    }

    const sentMsg: any = await res.json();

    if (reminder.selectedEmojis && reminder.selectedEmojis.length > 0) {
      for (const emojiId of reminder.selectedEmojis) {
        const emojiParam = emojiId.match(/^\d+$/) ? `_:${emojiId}` : encodeURIComponent(emojiId);
        try {
          await fetch(`https://discord.com/api/v10/channels/${reminder.channelId}/messages/${sentMsg.id}/reactions/${emojiParam}/@me`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`
            }
          });
        } catch (e) {
          console.warn(`[Scheduler] Failed to react with emoji ${emojiId}`);
        }
      }
    }

    return true;
  } catch (error) {
    console.error(`[Scheduler] Failed to send message for reminder ${reminder.id}:`, error);
    return false;
  }
};

export const checkAndSendReminders = async (env: HonoEnv['Bindings'], db: ReturnType<typeof drizzle>) => {
  console.log('[Cron] Starting reminder check...');
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

    // 1. D1から送信対象のリマインダーを取得
    const dueReminders = await db.select().from(schema.reminders).where(
      and(
        or(
          eq(schema.reminders.status, 'active'),
          and(
            eq(schema.reminders.status, 'processing'),
            lte(schema.reminders.lockedAt, fiveMinutesAgo)
          )
        ),
        lte(schema.reminders.nextNotificationTime, nowIso)
      )
    );

    if (dueReminders.length === 0) {
      console.log('[Cron] No due reminders found.');
      return;
    }

    console.log(`[Cron] Found ${dueReminders.length} due reminder(s).`);

    for (const reminder of dueReminders) {
      // Processing status update
      await db.update(schema.reminders)
        .set({ status: 'processing', lockedAt: nowIso })
        .where(eq(schema.reminders.id, reminder.id));

      const notificationTime = new Date(reminder.nextNotificationTime!);
      const missedBy = now.getTime() - notificationTime.getTime();

      if (missedBy < GRACE_PERIOD) {
        try {
          const success = await sendMessage(env, reminder, db);
          if (!success) {
            await db.insert(schema.missedNotifications).values({
              serverId: reminder.serverId,
              reminderMessage: `[送信エラー] ${reminder.message}`,
              missedAt: reminder.nextNotificationTime,
              channelName: reminder.channel,
              acknowledged: false
            });
          }
        } catch (error) {
          console.error(`[Cron] sendMessage threw an unexpected error for reminder ${reminder.id}:`, error);
        }
      } else {
        console.warn(`[Cron] SKIPPED reminder "${reminder.message}" (too late)`);
        await db.insert(schema.missedNotifications).values({
          serverId: reminder.serverId,
          reminderMessage: reminder.message,
          missedAt: reminder.nextNotificationTime,
          channelName: reminder.channel,
          acknowledged: false
        });
      }

      const { nextNotificationTime, nextOffsetIndex, newStartTime, eventTime } = calculateNextNotificationAfterSend(reminder);

      const updatePayload: any = { lockedAt: null };
      if (nextNotificationTime) {
        updatePayload.nextNotificationTime = nextNotificationTime;
        updatePayload.nextOffsetIndex = nextOffsetIndex;
        updatePayload.eventTime = eventTime;
        updatePayload.status = 'active';
        if (newStartTime) {
          updatePayload.startTime = newStartTime;
        }
      } else {
        updatePayload.nextNotificationTime = null;
        updatePayload.nextOffsetIndex = null;
        updatePayload.eventTime = null;
        updatePayload.status = 'paused';
      }

      await db.update(schema.reminders)
        .set(updatePayload)
        .where(eq(schema.reminders.id, reminder.id));

      console.log(`[Cron] Processed reminder ${reminder.id}.`);
    }

  } catch (error) {
    console.error('[Cron] Error during reminder check:', error);
  }
};
