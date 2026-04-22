import admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

function escapeSqlString(str: string | null | undefined): string {
    if (str === null || str === undefined) return 'NULL';
    if (typeof str === 'boolean') return str ? '1' : '0';
    if (typeof str === 'number') return str.toString();
    if (typeof str === 'object') {
        if (str && typeof (str as any).toDate === 'function') {
            return `'${(str as any).toDate().toISOString()}'`;
        }
        str = JSON.stringify(str);
    }
    return `'${String(str).replace(/'/g, "''")}'`;
}

async function main() {
    console.log('Fetching data from Firestore...');
    const sqlStatements: string[] = [];

    // Users
    const usersSnapshot = await db.collection('users').get();
    console.log(`Found ${usersSnapshot.docs.length} users.`);
    for (const doc of usersSnapshot.docs) {
        const data = doc.data();
        const guilds = Array.isArray(data.guilds) ? data.guilds : [];
        const sql = `INSERT OR REPLACE INTO users (id, username, avatar, accessToken, refreshToken, guilds, subscriptionStatus, expiresAt) VALUES (${escapeSqlString(doc.id)}, ${escapeSqlString(data.username)}, ${escapeSqlString(data.avatar)}, ${escapeSqlString(data.accessToken)}, ${escapeSqlString(data.refreshToken)}, ${escapeSqlString(guilds)}, ${escapeSqlString(data.subscriptionStatus)}, ${escapeSqlString(data.expiresAt)});`;
        sqlStatements.push(sql);
    }

    // Servers
    const serversSnapshot = await db.collection('servers').get();
    console.log(`Found ${serversSnapshot.docs.length} servers.`);
    for (const doc of serversSnapshot.docs) {
        const data = doc.data();
        const sql = `INSERT OR REPLACE INTO servers (id, channels, channelsFetchedAt, emojis, emojisFetchedAt, passwordHash, customName, customIcon, serverType) VALUES (${escapeSqlString(doc.id)}, ${escapeSqlString(data.channels)}, ${escapeSqlString(data.channelsFetchedAt)}, ${escapeSqlString(data.emojis)}, ${escapeSqlString(data.emojisFetchedAt)}, ${escapeSqlString(data.passwordHash)}, ${escapeSqlString(data.customName)}, ${escapeSqlString(data.customIcon)}, ${escapeSqlString(data.serverType || 'normal')});`;
        sqlStatements.push(sql);
    }

    // Reminders
    const remindersSnapshot = await db.collection('reminders').get();
    console.log(`Found ${remindersSnapshot.docs.length} reminders.`);
    for (const doc of remindersSnapshot.docs) {
        const data = doc.data();
        const sql = `INSERT OR REPLACE INTO reminders (id, serverId, createdBy, channel, channelId, message, startTime, recurrence, status, notificationOffsets, selectedEmojis, hideNextTime, nextNotificationTime, nextOffsetIndex, "order") VALUES (${escapeSqlString(doc.id)}, ${escapeSqlString(data.serverId)}, ${escapeSqlString(data.createdBy)}, ${escapeSqlString(data.channel)}, ${escapeSqlString(data.channelId)}, ${escapeSqlString(data.message)}, ${escapeSqlString(data.startTime)}, ${escapeSqlString(data.recurrence)}, ${escapeSqlString(data.status)}, ${escapeSqlString(data.notificationOffsets)}, ${escapeSqlString(data.selectedEmojis)}, ${escapeSqlString(data.hideNextTime)}, ${escapeSqlString(data.nextNotificationTime)}, ${escapeSqlString(data.nextOffsetIndex)}, ${escapeSqlString(data.order)});`;
        sqlStatements.push(sql);
    }

    // Audit Logs
    const auditLogsSnapshot = await db.collection('auditLogs').get();
    console.log(`Found ${auditLogsSnapshot.docs.length} auditLogs.`);
    for (const doc of auditLogsSnapshot.docs) {
        const data = doc.data();
        const sql = `INSERT OR REPLACE INTO audit_logs (id, user, action, reminderMessage, before, after, serverId, timestamp) VALUES (${escapeSqlString(Number(doc.id) || null)}, ${escapeSqlString(data.user)}, ${escapeSqlString(data.action)}, ${escapeSqlString(data.reminderMessage)}, ${escapeSqlString(data.before)}, ${escapeSqlString(data.after)}, ${escapeSqlString(data.serverId)}, ${escapeSqlString(data.timestamp)});`;
        sqlStatements.push(sql);
    }

    // Missed Notifications
    const missedSnapshot = await db.collection('missedNotifications').get();
    console.log(`Found ${missedSnapshot.docs.length} missedNotifications.`);
    for (const doc of missedSnapshot.docs) {
        const data = doc.data();
        const sql = `INSERT OR REPLACE INTO missed_notifications (id, serverId, reminderMessage, missedAt, channelName, acknowledged) VALUES (${escapeSqlString(Number(doc.id) || null)}, ${escapeSqlString(data.serverId)}, ${escapeSqlString(data.reminderMessage)}, ${escapeSqlString(data.missedAt)}, ${escapeSqlString(data.channelName)}, ${escapeSqlString(data.acknowledged)});`;
        sqlStatements.push(sql);
    }

    const outputPath = './d1_migration_data.sql';
    fs.writeFileSync(outputPath, sqlStatements.join('\n'), 'utf8');
    console.log(`Successfully wrote ${sqlStatements.length} SQL statements to ${outputPath}`);
}

main().catch(console.error);
