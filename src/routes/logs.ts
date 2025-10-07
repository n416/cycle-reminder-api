import { Router } from 'express';
import { db } from '../config/firebase';
import { protect } from '../middleware/auth';

const router = Router();

// GET /api/logs/:serverId - 特定サーバーのログを取得 (新しい順)
router.get('/:serverId', protect, async (req, res) => {
  try {
    const { serverId } = req.params;
    const snapshot = await db.collection('auditLogs')
      .where('serverId', '==', serverId) // serverIdでフィルタリング
      .orderBy('timestamp', 'desc')
      .get();
    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(logs);
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

export default router;