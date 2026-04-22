import { Hono } from 'hono';
import { HonoEnv } from '../hono';
import { protect, protectWrite } from '../middleware/auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq, and } from 'drizzle-orm';
// Removed @discordjs/rest dependency

const remindersRouter = new Hono<HonoEnv>();

const addLogWithTrim = async (db: ReturnType<typeof drizzle>, logData: any) => {
    await db.insert(schema.auditLogs).values({
        ...logData,
        timestamp: new Date().toISOString(),
    });
    // Trimming could be done via a separate cron job, or we can just let it grow a bit and clean up periodically.
    // For simplicity, we skip the hard trim per request in SQLite to avoid complex queries.
};

const calculateNextNotificationInfo = (
    reminderData: any,
    baseTime: Date
  ): { nextNotificationTime: string | null; nextOffsetIndex: number | null } => {
  
    const startDate = new Date(reminderData.startTime);
    if (isNaN(startDate.getTime())) return { nextNotificationTime: null, nextOffsetIndex: null };
  
    let nextCycleTime: Date | null = null;
  
    switch (reminderData.recurrence.type) {
      case 'none':
        nextCycleTime = startDate >= baseTime ? startDate : null;
        break;
  
      case 'daily': {
        let nextDate = baseTime > startDate ? new Date(baseTime) : new Date(startDate);
        nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
        if (nextDate <= baseTime) {
          nextDate.setDate(nextDate.getDate() + 1);
        }
        nextCycleTime = nextDate;
        break;
      }
  
      case 'interval': {
        let nextDate = new Date(startDate);
        while (nextDate <= baseTime) {
          nextDate.setHours(nextDate.getHours() + reminderData.recurrence.hours);
        }
        nextCycleTime = nextDate;
        break;
      }
  
      case 'weekly': {
        const dayMap: { [key: string]: number } = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
        const targetDaysOfWeek = new Set((reminderData.recurrence.days || []).map((day: string) => dayMap[day]));
        if (targetDaysOfWeek.size === 0) {
          nextCycleTime = null;
          break;
        }
        let nextDate = baseTime > startDate ? new Date(baseTime) : new Date(startDate);
        nextDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
        if (nextDate <= baseTime) {
          nextDate.setDate(nextDate.getDate() + 1);
        }
        for (let i = 0; i < 7; i++) {
          if (targetDaysOfWeek.has(nextDate.getDay())) {
            nextCycleTime = nextDate;
            break;
          }
          nextDate.setDate(nextDate.getDate() + 1);
        }
        break;
      }
      default:
        nextCycleTime = null;
    }
  
    if (!nextCycleTime) {
      return { nextNotificationTime: null, nextOffsetIndex: null };
    }
  
    const offsets = reminderData.notificationOffsets || [0];
  
    for (let i = 0; i < offsets.length; i++) {
      const offsetMinutes = offsets[i];
      const notificationTime = new Date(nextCycleTime.getTime() - offsetMinutes * 60 * 1000);
  
      if (notificationTime > baseTime) {
        return {
          nextNotificationTime: notificationTime.toISOString(),
          nextOffsetIndex: i
        };
      }
    }
  
    return { nextNotificationTime: null, nextOffsetIndex: null };
};

const sanitizeMessage = (message: string): string => {
    return message
      .replace(/@everyone/g, '＠everyone')
      .replace(/@here/g, '＠here')
      .replace(/<@&(\d+)>/g, '＠ロール')
      .replace(/<@!?(\d+)>/g, '＠ユーザー');
};

remindersRouter.get('/:serverId', protect, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const db = drizzle(c.env.DB, { schema });
        const results = await db.select().from(schema.reminders).where(eq(schema.reminders.serverId, serverId));
        
        results.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
        return c.json(results);
    } catch (error) {
        console.error("Failed to fetch reminders:", error);
        return c.json({ error: 'Failed to fetch reminders' }, 500);
    }
});

remindersRouter.post('/:serverId', protect, protectWrite, async (c) => {
    const appRole = c.get('user').role;
    if (appRole !== 'owner' && appRole !== 'tester') {
        return c.json({ message: 'Forbidden: Only owners or testers can create new reminders.' }, 403);
    }

    try {
        const serverId = c.req.param('serverId');
        const reminderData = await c.req.json();
        
        // Remove userId if it exists
        delete reminderData.userId;

        const offsets = (reminderData.notificationOffsets || [0])
            .filter((n: number) => typeof n === 'number' && n >= 0)
            .sort((a: number, b: number) => b - a);

        const dataWithOffsets = {
            ...reminderData,
            notificationOffsets: offsets.length > 0 ? offsets : [0],
        };

        const { nextNotificationTime, nextOffsetIndex } = calculateNextNotificationInfo(dataWithOffsets, new Date());

        const newId = crypto.randomUUID();
        const newReminderData = {
            ...dataWithOffsets,
            id: newId,
            serverId: serverId,
            createdBy: c.get('user').id,
            nextNotificationTime: nextNotificationTime,
            nextOffsetIndex: nextOffsetIndex,
            selectedEmojis: reminderData.selectedEmojis || [],
        };

        const db = drizzle(c.env.DB, { schema });
        await db.insert(schema.reminders).values(newReminderData);

        await addLogWithTrim(db, {
            user: c.get('user').username,
            action: '作成',
            reminderMessage: newReminderData.message,
            after: newReminderData,
            serverId: serverId,
        });

        return c.json(newReminderData, 201);
    } catch (error) {
        console.error("Failed to create reminder:", error);
        return c.json({ error: 'Failed to create reminder' }, 500);
    }
});

remindersRouter.put('/:id', protect, protectWrite, async (c) => {
    try {
        const id = c.req.param('id');
        const updatedBody = await c.req.json();
        const db = drizzle(c.env.DB, { schema });

        const beforeData = await db.select().from(schema.reminders).where(eq(schema.reminders.id, id)).get();
        if (!beforeData) {
            return c.json({ error: "Reminder not found." }, 404);
        }

        const offsets = (updatedBody.notificationOffsets || [0])
            .filter((n: number) => typeof n === 'number' && n >= 0)
            .sort((a: number, b: number) => b - a);

        const dataWithOffsets = {
            ...updatedBody,
            notificationOffsets: offsets.length > 0 ? offsets : [0],
            selectedEmojis: updatedBody.selectedEmojis || [],
        };

        const { nextNotificationTime, nextOffsetIndex } = calculateNextNotificationInfo(dataWithOffsets, new Date());

        const updatedData = {
            ...dataWithOffsets,
            nextNotificationTime,
            nextOffsetIndex,
        };

        await db.update(schema.reminders).set(updatedData).where(eq(schema.reminders.id, id));

        await addLogWithTrim(db, {
            user: c.get('user').username,
            action: '更新',
            reminderMessage: updatedData.message,
            before: beforeData,
            after: { id, ...updatedData },
            serverId: beforeData.serverId,
        });

        return c.json({ id, ...updatedData });
    } catch (error) {
        console.error("Failed to update reminder:", error);
        return c.json({ error: 'Failed to update reminder' }, 500);
    }
});

remindersRouter.delete('/:id', protect, protectWrite, async (c) => {
    try {
        const id = c.req.param('id');
        const db = drizzle(c.env.DB, { schema });
        
        const beforeData = await db.select().from(schema.reminders).where(eq(schema.reminders.id, id)).get();
        if (!beforeData) {
            return c.json({ error: "Reminder not found." }, 404);
        }

        await db.delete(schema.reminders).where(eq(schema.reminders.id, id));

        await addLogWithTrim(db, {
            user: c.get('user').username,
            action: '削除',
            reminderMessage: beforeData.message,
            before: beforeData,
            serverId: beforeData.serverId,
        });

        return c.json({ message: 'Reminder deleted successfully' });
    } catch (error) {
        console.error("Failed to delete reminder:", error);
        return c.json({ error: 'Failed to delete reminder' }, 500);
    }
});

remindersRouter.post('/:serverId/test-send', protect, protectWrite, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const { channelId, message, selectedEmojis } = await c.req.json();

        if (!channelId || !message) {
            return c.json({ message: 'channelId and message are required.' }, 400);
        }

        let finalMessage = sanitizeMessage(message);
        
        // Simple {{all}} expansion fallback for test (you may want to keep the full logic)
        if (finalMessage.includes('{{all}}')) {
             finalMessage = finalMessage.replace('{{all}}', '\n**--- 24時間以内の予定 ---**\n(テスト送信のためリストは省略)');
        }

        const testMessage = `＝＝＝テスト送信です＝＝＝\n${finalMessage}`;

        const isDev = c.env.NODE_ENV === 'development' || c.env.FRONTEND_URL?.includes('localhost') || c.env.FRONTEND_URL?.includes('127.0.0.1');
        if (isDev && serverId === 'dev_server_1') {
            console.log('[Dev Bypass] Skipped real Discord API call for test message:', testMessage);
            return c.json({ message: 'Test message simulated successfully in dev mode.' });
        }

        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${c.env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: testMessage })
        });

        if (!res.ok) {
            throw new Error(`Discord API error: ${res.statusText}`);
        }

        const sentMsg: any = await res.json();

        if (selectedEmojis && selectedEmojis.length > 0) {
            for (const emojiId of selectedEmojis) {
                // Determine if emojiId is custom (snowflake) or unicode
                const emojiParam = emojiId.match(/^\d+$/) ? `_:${emojiId}` : encodeURIComponent(emojiId);
                try {
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${sentMsg.id}/reactions/${emojiParam}/@me`, {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bot ${c.env.DISCORD_BOT_TOKEN}`
                        }
                    });
                } catch (e) {
                    console.warn(`[Test Send] Failed to react with emoji ${emojiId}`);
                }
            }
        }
        
        return c.json({ message: 'Test message sent successfully.' });
    } catch (error) {
        console.error("!!! [Test Send - ERROR] An error occurred during test send:", error);
        return c.json({ error: 'Failed to send test message' }, 500);
    }
});

remindersRouter.put('/:serverId/reorder', protect, protectWrite, async (c) => {
    try {
        const { reminders } = await c.req.json();
        const db = drizzle(c.env.DB, { schema });
        
        // D1 doesn't have a single bulk update query easily in drizzle without mapping, so loop updates
        // Since it's local sqlite / Cloudflare D1, we can just await Promise.all
        await Promise.all(reminders.map((item: any) => 
             db.update(schema.reminders).set({ order: item.order }).where(eq(schema.reminders.id, item.id))
        ));

        return c.json({ message: 'Order updated' });
    } catch (error) {
        console.error("Failed to reorder reminders:", error);
        return c.json({ error: 'Failed to reorder reminders' }, 500);
    }
});

remindersRouter.post('/:serverId/daily-summary', protect, protectWrite, async (c) => {
    // Porting the logic
    try {
        const serverId = c.req.param('serverId');
        const { channelId, time } = await c.req.json();

        if (!channelId || !time || !/^\d{2}:\d{2}$/.test(time)) {
            return c.json({ error: 'channelId and time (HH:mm format) are required.' }, 400);
        }

        const [hours, minutes] = time.split(':').map(Number);
        const startTime = new Date();
        startTime.setHours(hours, minutes, 0, 0);

        const reminderData = {
            serverId: serverId,
            message: '今日の予定\n{{all}}',
            channel: 'Channel', // We should look up the channel name ideally, simplified here
            channelId: channelId,
            startTime: startTime.toISOString(),
            recurrence: { type: 'daily' },
            status: 'active',
            notificationOffsets: [0],
            selectedEmojis: [],
            hideNextTime: false,
        };

        const { nextNotificationTime, nextOffsetIndex } = calculateNextNotificationInfo(reminderData, new Date());

        const newId = crypto.randomUUID();
        const newReminderData = {
            ...reminderData,
            id: newId,
            createdBy: c.get('user').id,
            nextNotificationTime: nextNotificationTime,
            nextOffsetIndex: nextOffsetIndex,
        };

        const db = drizzle(c.env.DB, { schema });
        await db.insert(schema.reminders).values(newReminderData as any);

        return c.json(newReminderData, 201);

    } catch (error) {
        console.error("Failed to create daily summary reminder:", error);
        return c.json({ error: 'Failed to create daily summary reminder' }, 500);
    }
});

export default remindersRouter;