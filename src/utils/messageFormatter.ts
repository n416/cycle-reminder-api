import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq, and, lte, asc } from 'drizzle-orm';

export interface ReminderContext {
  nextOffsetIndex?: number;
  notificationOffsets?: number[];
}

export const sanitizeMessage = (message: string): string => {
  if (!message) return '';
  return message
    .replace(/@everyone/g, '＠everyone')
    .replace(/@here/g, '＠here')
    .replace(/<@&(\d+)>/g, '＠ロール')
    .replace(/<@!?(\d+)>/g, '＠ユーザー');
};

export const formatMessageContent = async (
  db: ReturnType<typeof drizzle>,
  serverId: string,
  rawMessage: string,
  context?: ReminderContext
): Promise<string> => {
  let finalMessage = sanitizeMessage(rawMessage);
  if (!finalMessage) return '';

  if (/\{\{hitboss-paste\}\}/i.test(finalMessage)) {
    const allActiveReminders = await db.select().from(schema.reminders).where(
      and(
        eq(schema.reminders.serverId, serverId),
        eq(schema.reminders.status, 'active')
      )
    );

    const bossOrder = [
      { name: 'スケ', regex: /スケロ/ },
      { name: 'リセ', regex: /リセメン/ },
      { name: 'ユリ', regex: /ユリア/ },
      { name: 'グレ', regex: /グレゴ/ },
      { name: 'ケン', regex: /ケンタ/ },
      { name: 'アル', regex: /アルサ/ },
      { name: 'アズ', regex: /アズラエル/ }
    ];

    let foundBosses: { name: string; timeMs: number; minuteStr: string }[] = [];

    for (const boss of bossOrder) {
      const bossReminder = allActiveReminders.find(r => r.message && boss.regex.test(r.message));
      if (bossReminder && bossReminder.eventTime) {
        let d = new Date(bossReminder.eventTime);
        if (isNaN(d.getTime())) {
          try {
            const parsed = JSON.parse(bossReminder.eventTime);
            if (parsed && parsed._seconds) {
              d = new Date(parsed._seconds * 1000);
            }
          } catch (e) { }
        }
        if (!isNaN(d.getTime())) {
          const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
          const minuteStr = jst.getUTCMinutes().toString().padStart(2, '0');
          foundBosses.push({
            name: boss.name,
            timeMs: d.getTime(),
            minuteStr: minuteStr
          });
        }
      }
    }

    foundBosses.sort((a, b) => a.timeMs - b.timeMs);
    const pasteStrParts = foundBosses.map(b => `${b.name} ${b.minuteStr}`);
    const pasteStr = pasteStrParts.length > 0 ? pasteStrParts.join('  ') : '（ボス予定なし）';
    finalMessage = finalMessage.replace(/\{\{hitboss-paste\}\}/ig, pasteStr);
  }

  if (/\{\{all\}\}/i.test(finalMessage)) {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    const upcomingReminders = await db.select().from(schema.reminders).where(
      and(
        eq(schema.reminders.serverId, serverId),
        eq(schema.reminders.status, 'active'),
        lte(schema.reminders.nextNotificationTime, in24Hours)
      )
    ).orderBy(asc(schema.reminders.nextNotificationTime));

    let listStr = upcomingReminders.map(r => {
      if (!r.eventTime) return null;
      let d = new Date(r.eventTime);
      if (isNaN(d.getTime())) {
        try {
          const parsed = JSON.parse(r.eventTime);
          if (parsed && parsed._seconds) {
            d = new Date(parsed._seconds * 1000);
          }
        } catch (e) { }
      }
      if (isNaN(d.getTime())) return null;

      const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const timeStr = `${jst.getUTCHours().toString().padStart(2, '0')}:${jst.getUTCMinutes().toString().padStart(2, '0')}`;

      if (r.message && /\{\{all\}\}/i.test(r.message)) return null;

      const cleanMsg = (r.message || '').replace(/\{\{.*?\}\}/g, '').replace(/\n/g, ' ').trim();

      let offsets = r.notificationOffsets;
      if (typeof offsets === 'string') {
        try { offsets = JSON.parse(offsets); } catch (e) { }
      }
      let offsetStr = '';
      return `${timeStr} - ${cleanMsg}${offsetStr}`;
    }).filter(Boolean).join('\n');

    if (!listStr) {
      listStr = '予定はありません';
    }
    finalMessage = finalMessage.replace(/\{\{all\}\}/ig, `\n**--- 24時間以内の予定 ---**\n${listStr}`);
  } else if (/\{\{offset\}\}/i.test(finalMessage)) {
    const offsets = context?.notificationOffsets || [0];
    const currentOffset = offsets[context?.nextOffsetIndex || 0] || 0;
    if (currentOffset > 0) {
      finalMessage = finalMessage.replace(/\{\{offset\}\}/ig, `まであと ${currentOffset} 分`);
    } else {
      finalMessage = finalMessage.replace(/\{\{offset\}\}/ig, 'の時間です！');
    }
  }

  return finalMessage;
};
