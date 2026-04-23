import * as schema from './db/schema';
import { eq, and, lte, asc } from 'drizzle-orm';
// Removed @discordjs/rest dependency
const GRACE_PERIOD = 10 * 60 * 1000; // 10分
const calculateNextNotificationAfterSend = (reminder) => {
    const startDate = new Date(reminder.startTime);
    if (isNaN(startDate.getTime()))
        return { nextNotificationTime: null, nextOffsetIndex: null, newStartTime: null };
    const offsets = reminder.notificationOffsets || [0];
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
        };
    }
    let nextCycleTime = null;
    const lastCycleTime = new Date(new Date(reminder.nextNotificationTime).getTime() + offsets[currentOffsetIndex] * 60 * 1000);
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
            const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
            const targetDaysOfWeek = new Set((reminder.recurrence.days || []).map((day) => dayMap[day]));
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
        return { nextNotificationTime: null, nextOffsetIndex: null, newStartTime: null };
    }
    const firstOffset = offsets[0] || 0;
    const nextNotificationTime = new Date(nextCycleTime.getTime() - firstOffset * 60 * 1000);
    return {
        nextNotificationTime: nextNotificationTime.toISOString(),
        nextOffsetIndex: 0,
        newStartTime: lastCycleTime.toISOString(),
    };
};
const sanitizeMessage = (message) => {
    return message
        .replace(/@everyone/g, '＠everyone')
        .replace(/@here/g, '＠here')
        .replace(/<@&(\d+)>/g, '＠ロール')
        .replace(/<@!?(\d+)>/g, '＠ユーザー');
};
const sendMessage = async (env, reminder, db) => {
    try {
        let finalMessage = sanitizeMessage(reminder.message);
        if (finalMessage.includes('{{all}}')) {
            const now = new Date();
            const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
            // 24時間以内のアクティブなリマインダーを取得
            const upcomingReminders = await db.select().from(schema.reminders).where(and(eq(schema.reminders.serverId, reminder.serverId), eq(schema.reminders.status, 'active'), lte(schema.reminders.nextNotificationTime, in24Hours))).orderBy(asc(schema.reminders.nextNotificationTime));
            let listStr = upcomingReminders.map(r => {
                if (!r.nextNotificationTime)
                    return null;
                // JSTに変換してフォーマット (HH:MM)
                const d = new Date(r.nextNotificationTime);
                const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
                const timeStr = `${jst.getUTCHours().toString().padStart(2, '0')}:${jst.getUTCMinutes().toString().padStart(2, '0')}`;
                // メッセージ内のプレースホルダーを除去
                const cleanMsg = (r.message || '').replace(/\{\{.*?\}\}/g, '').trim();
                // 通知オフセットの取得
                let offsets = r.notificationOffsets;
                if (typeof offsets === 'string') {
                    try {
                        offsets = JSON.parse(offsets);
                    }
                    catch (e) { }
                }
                let offsetStr = '';
                if (Array.isArray(offsets) && offsets.length > 0) {
                    offsetStr = `【${offsets.join(',')}分前通知】`;
                }
                return `${timeStr} - ${cleanMsg}${offsetStr}`;
            }).filter(Boolean).join('\n');
            if (!listStr) {
                listStr = '予定はありません';
            }
            finalMessage = finalMessage.replace('{{all}}', `\n**--- 24時間以内の予定 ---**\n${listStr}`);
        }
        else if (finalMessage.includes('{{offset}}')) {
            const offsets = reminder.notificationOffsets || [0];
            const currentOffset = offsets[reminder.nextOffsetIndex || 0];
            if (currentOffset > 0) {
                finalMessage = finalMessage.replace('{{offset}}', `まであと ${currentOffset} 分`);
            }
            else {
                finalMessage = finalMessage.replace('{{offset}}', 'の時間です！');
            }
        }
        const isDev = env.NODE_ENV === 'development' || env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
        if (isDev && reminder.serverId === 'dev_server_1') {
            console.log(`[Scheduler] Dev Mode: Sent reminder ${reminder.id} to channel ${reminder.channelId}. Content: ${finalMessage}`);
            return;
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
        const sentMsg = await res.json();
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
                }
                catch (e) {
                    console.warn(`[Scheduler] Failed to react with emoji ${emojiId}`);
                }
            }
        }
    }
    catch (error) {
        console.error(`[Scheduler] Failed to send message for reminder ${reminder.id}:`, error);
    }
};
export const checkAndSendReminders = async (env, db) => {
    console.log('[Cron] Starting reminder check...');
    try {
        const now = new Date();
        const nowIso = now.toISOString();
        // 1. D1から送信対象のリマインダーを取得
        const dueReminders = await db.select().from(schema.reminders).where(and(eq(schema.reminders.status, 'active'), lte(schema.reminders.nextNotificationTime, nowIso)));
        if (dueReminders.length === 0) {
            console.log('[Cron] No due reminders found.');
            return;
        }
        console.log(`[Cron] Found ${dueReminders.length} due reminder(s).`);
        for (const reminder of dueReminders) {
            // Processing status update
            await db.update(schema.reminders)
                .set({ status: 'processing' })
                .where(eq(schema.reminders.id, reminder.id));
            const notificationTime = new Date(reminder.nextNotificationTime);
            const missedBy = now.getTime() - notificationTime.getTime();
            if (missedBy < GRACE_PERIOD) {
                await sendMessage(env, reminder, db);
            }
            else {
                console.warn(`[Cron] SKIPPED reminder "${reminder.message}" (too late)`);
                await db.insert(schema.missedNotifications).values({
                    serverId: reminder.serverId,
                    reminderMessage: reminder.message,
                    missedAt: reminder.nextNotificationTime,
                    channelName: reminder.channel,
                    acknowledged: false
                });
            }
            const { nextNotificationTime, nextOffsetIndex, newStartTime } = calculateNextNotificationAfterSend(reminder);
            const updatePayload = {};
            if (nextNotificationTime) {
                updatePayload.nextNotificationTime = nextNotificationTime;
                updatePayload.nextOffsetIndex = nextOffsetIndex;
                updatePayload.status = 'active';
                if (newStartTime) {
                    updatePayload.startTime = newStartTime;
                }
            }
            else {
                updatePayload.nextNotificationTime = null;
                updatePayload.nextOffsetIndex = null;
                updatePayload.status = 'paused';
            }
            await db.update(schema.reminders)
                .set(updatePayload)
                .where(eq(schema.reminders.id, reminder.id));
            console.log(`[Cron] Processed reminder ${reminder.id}.`);
        }
    }
    catch (error) {
        console.error('[Cron] Error during reminder check:', error);
    }
};
