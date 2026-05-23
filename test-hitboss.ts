import { eq, and } from 'drizzle-orm';

// モックデータ: 実際のDBから取得する値のシミュレーション
const allActiveReminders = [
  { message: '墓地 2F） スケロ {{offset}}', eventTime: new Date('2026-05-23T10:01:00Z').toISOString() },
  { message: '墓地 3F） リセメン {{offset}}', eventTime: new Date('2026-05-23T10:02:00Z').toISOString() },
  { message: '墓地 4F） ユリア {{offset}}', eventTime: new Date('2026-05-23T10:05:00Z').toISOString() },
  { message: '啓示 3F） グレゴ {{offset}}', eventTime: new Date('2026-05-23T10:10:00Z').toISOString() },
  // ケンタは未登録という想定
  { message: '黎明 2F） アルサ {{offset}}', eventTime: new Date('2026-05-23T10:15:00Z').toISOString() },
  { message: '黎明 5F） アズラエル {{offset}}', eventTime: new Date('2026-05-23T10:20:00Z').toISOString() },
];

let finalMessage = "ボスの出現時間は以下の通りです。\n{{hitboss-paste}}\n準備をお願いします！";

console.log("=== 変換前のメッセージ ===");
console.log(finalMessage);
console.log("\n--------------------------\n");

// 実装したロジックのコピペ
if (/\{\{hitboss-paste\}\}/i.test(finalMessage)) {
    const bossOrder = [
        { name: 'スケロ', regex: /スケロ/ },
        { name: 'リセメ', regex: /リセメン/ },
        { name: 'ユリア', regex: /ユリア/ },
        { name: 'グレゴ', regex: /グレゴ/ },
        { name: 'ケンタ', regex: /ケンタ/ },
        { name: 'アルサ', regex: /アルサ/ },
        { name: 'アズラ', regex: /アズラエル/ }
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
                } catch (e) {}
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

console.log("=== 変換後のメッセージ ===");
console.log(finalMessage);
