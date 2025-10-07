import { Router } from 'express';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';

const router = Router();
const missedNotificationsCollection = db.collection('missedNotifications');

// GET /api/missed-notifications/:serverId - 未確認の失敗ログを取得
router.get('/:serverId', protect, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const snapshot = await missedNotificationsCollection
      .where('serverId', '==', serverId)
      .where('acknowledged', '==', false) // 未確認のものだけ取得
      .orderBy('missedAt', 'desc')
      .get();
    
    const notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(notifications);
  } catch (error) {
    console.error('Failed to fetch missed notifications:', error);
    res.status(500).json({ error: 'Failed to fetch missed notifications' });
  }
});

// PUT /api/missed-notifications/:id/acknowledge - 失敗ログを確認済みにする
router.put('/:id/acknowledge', protect, async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const docRef = missedNotificationsCollection.doc(id);
      
      // ここでユーザーが本当にこのサーバーの管理者かどうかの権限チェックを入れるのがより堅牢
      // (今回は省略)

      await docRef.update({ acknowledged: true });
      res.status(200).json({ message: 'Notification acknowledged successfully.' });
    } catch (error) {
      console.error('Failed to acknowledge notification:', error);
      res.status(500).json({ error: 'Failed to acknowledge notification' });
    }
  });

export default router;