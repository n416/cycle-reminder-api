import { Hono } from 'hono';
import { protect } from '../middleware/auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
const missedNotificationsRouter = new Hono();
missedNotificationsRouter.get('/:serverId', protect, async (c) => {
    try {
        const serverId = c.req.param('serverId');
        const db = drizzle(c.env.DB, { schema });
        const notifications = await db.select()
            .from(schema.missedNotifications)
            .where(and(eq(schema.missedNotifications.serverId, serverId), eq(schema.missedNotifications.acknowledged, false)))
            .orderBy(desc(schema.missedNotifications.missedAt));
        return c.json(notifications);
    }
    catch (error) {
        console.error('Failed to fetch missed notifications:', error);
        return c.json({ error: 'Failed to fetch missed notifications' }, 500);
    }
});
missedNotificationsRouter.put('/:id/acknowledge', protect, async (c) => {
    try {
        const id = parseInt(c.req.param('id'), 10);
        const db = drizzle(c.env.DB, { schema });
        await db.update(schema.missedNotifications)
            .set({ acknowledged: true })
            .where(eq(schema.missedNotifications.id, id));
        return c.json({ message: 'Notification acknowledged successfully.' });
    }
    catch (error) {
        console.error('Failed to acknowledge notification:', error);
        return c.json({ error: 'Failed to acknowledge notification' }, 500);
    }
});
export default missedNotificationsRouter;
