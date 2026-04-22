import { Hono } from 'hono';
import { HonoEnv } from '../hono';
import { protect } from '../middleware/auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq, desc } from 'drizzle-orm';

const logsRouter = new Hono<HonoEnv>();

logsRouter.get('/:serverId', protect, async (c) => {
  try {
    const serverId = c.req.param('serverId');
    const db = drizzle(c.env.DB, { schema });
    
    const logs = await db.select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.serverId, serverId))
      .orderBy(desc(schema.auditLogs.timestamp));
      
    return c.json(logs);
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    return c.json({ error: 'Failed to fetch audit logs' }, 500);
  }
});

export default logsRouter;