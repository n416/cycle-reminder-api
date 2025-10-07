type RecurrenceRule =
  | { type: 'none' }
  | { type: 'weekly'; days: string[] }
  | { type: 'interval'; hours: number };

export interface Reminder {
  id: string;
  serverId: string;
  message: string;
  channel: string;
  channelId: string;
  startTime: string;
  recurrence: RecurrenceRule;
  status: 'active' | 'paused';
  createdBy: string;
  nextNotificationTime?: any; // Firestore Timestamp
}

// --- ★★★ ここから追加 ★★★ ---
export interface MissedNotification {
  id: string;
  serverId: string;
  reminderMessage: string;
  missedAt: any; // Firestore Timestamp
  channelName: string;
  acknowledged: boolean;
}
// --- ★★★ ここまで追加 ★★★ ---