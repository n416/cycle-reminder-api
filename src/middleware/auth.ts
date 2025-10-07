import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { db } from '../config/firebase'; // Firestoreインスタンスをインポート

dotenv.config();

export interface AuthRequest extends Request {
  user?: any;
  writeAccessInfo?: any;
}

export const protect = (req: AuthRequest, res: Response, next: NextFunction) => {
  const bearer = req.headers.authorization;

  if (!bearer || !bearer.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  const token = bearer.split('Bearer ')[1];
  try {
    const user = jwt.verify(token, process.env.DISCORD_CLIENT_SECRET!);
    req.user = user;
    next();
  } catch (error) {
    console.error('【バックエンド】トークンの検証に失敗しました:', error);
    return res.status(401).json({ message: 'Unauthorized: Invalid Token' });
  }
};

export const protectWrite = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const writeToken = req.headers['x-write-token'] as string;
  // --- ★★★ ここからロジックを修正 ★★★ ---
  const { id: reminderId, serverId: serverIdFromParams } = req.params;

  if (!writeToken) {
    return res.status(401).json({ message: 'Unauthorized: Write token is required for this operation.' });
  }

  try {
    const decoded = jwt.verify(writeToken, process.env.DISCORD_CLIENT_SECRET!) as { serverId: string; [key: string]: any };
    req.writeAccessInfo = decoded;
    
    if (reminderId) {
      // --- ケース1: 既存リマインダーの更新・削除 (URLにreminderIdがある場合) ---
      const reminderRef = db.collection('reminders').doc(reminderId);
      const reminderDoc = await reminderRef.get();
      if (!reminderDoc.exists) {
        return res.status(404).json({ message: 'Reminder not found.' });
      }
      const reminderData = reminderDoc.data();
      
      if (reminderData?.serverId !== decoded.serverId) {
        return res.status(403).json({ message: 'Forbidden: You do not have permission to modify this reminder.' });
      }
    } else if (serverIdFromParams) {
      // --- ケース2: 新規リマインダーの作成 (URLにserverIdがある場合) ---
      if (serverIdFromParams !== decoded.serverId) {
        return res.status(403).json({ message: 'Forbidden: You do not have permission to create a reminder on this server.' });
      }
    } else {
      // 予期せぬルートでの使用
      return res.status(400).json({ message: 'Bad Request: Invalid route for write protection.' });
    }

    // 検証成功
    next();
    // --- ★★★ ここまで修正 ★★★ ---
  } catch (error) {
    console.error('【バックエンド】書き込みトークンの検証に失敗しました:', error);
    return res.status(401).json({ message: 'Unauthorized: Invalid Write Token' });
  }
};