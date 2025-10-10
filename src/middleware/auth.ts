import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { db } from '../config/firebase';

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
    // ★★★★★ ここが修正箇所です ★★★★★
    // トークンを検証し、デコードされたペイロード全体を req.user にセットする
    const payload = jwt.verify(token, process.env.DISCORD_CLIENT_SECRET!);
    req.user = payload;
    // ★★★★★ ここまで ★★★★★
    next();
  } catch (error) {
    console.error('【バックエンド】トークンの検証に失敗しました:', error);
    return res.status(401).json({ message: 'Unauthorized: Invalid Token' });
  }
};

export const protectWrite = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const writeToken = req.headers['x-write-token'] as string;
  const { id: reminderId, serverId: serverIdFromParams } = req.params;

  if (!writeToken) {
    return res.status(401).json({ message: 'Unauthorized: Write token is required for this operation.' });
  }

  try {
    const decoded = jwt.verify(writeToken, process.env.DISCORD_CLIENT_SECRET!) as { serverId: string; [key: string]: any };
    req.writeAccessInfo = decoded;
    
    if (reminderId) {
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
      if (serverIdFromParams !== decoded.serverId) {
        return res.status(403).json({ message: 'Forbidden: You do not have permission to create a reminder on this server.' });
      }
    } else {
      return res.status(400).json({ message: 'Bad Request: Invalid route for write protection.' });
    }

    next();
  } catch (error) {
    console.error('【バックエンド】書き込みトークンの検証に失敗しました:', error);
    return res.status(401).json({ message: 'Unauthorized: Invalid Write Token' });
  }
};