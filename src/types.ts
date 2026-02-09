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
  startTime: string;
  recurrence: RecurrenceRule;
  status: 'active' | 'paused' | 'processing';
  createdBy: string;
  nextNotificationTime?: any;
  selectedEmojis?: string[];
  hideNextTime?: boolean;
  notificationOffsets?: number[];
  nextOffsetIndex?: number;
  order?: number; // Added for sorting
}

export interface MissedNotification {
  id: string;
  serverId: string;
  reminderMessage: string;
  missedAt: any;
  channelName: string;
  acknowledged: boolean;
}
