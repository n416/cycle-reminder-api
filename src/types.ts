type RecurrenceRule =
  | { type: 'none' }
  | { type: 'weekly'; days: string[] }
  | { type: 'interval'; hours: number }
  | { type: 'daily' };

export interface Reminder {
  id: string;
  serverId: string;
  message: string;
  channel: string;
  channelId: string;
  startTime: string; // ★★★ anyからstringに修正 ★★★
  recurrence: RecurrenceRule;
  status: 'active' | 'paused' | 'processing';
  createdBy: string;
  nextNotificationTime?: any; // 次に通知すべき「オフセット適用後」の絶対時刻
  selectedEmojis?: string[];
  hideNextTime?: boolean;

  /** * 事前通知オフセット（分単位）。[60, 10, 0] の場合、60分前, 10分前, 時間丁度に通知。
   * 降順（大きい数から小さい数へ）でソートされている必要がある。
   */
  notificationOffsets?: number[];
  /**
   * 次に通知すべきオフセットが `notificationOffsets` 配列の何番目かを示すインデックス。
   * 例: [60, 10, 0] の場合、次は60分前なら 0, 10分前なら 1。
   */
  nextOffsetIndex?: number;
}

export interface MissedNotification {
  id: string;
  serverId: string;
  reminderMessage: string;
  missedAt: any; // Firestore Timestamp
  channelName: string;
  acknowledged: boolean;
}