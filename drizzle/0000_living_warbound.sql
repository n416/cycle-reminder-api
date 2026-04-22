CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user` text,
	`action` text,
	`reminderMessage` text,
	`before` text,
	`after` text,
	`serverId` text,
	`timestamp` text
);
--> statement-breakpoint
CREATE TABLE `missed_notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`serverId` text,
	`reminderMessage` text,
	`missedAt` text,
	`channelName` text,
	`acknowledged` integer DEFAULT false
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`serverId` text,
	`createdBy` text,
	`channel` text,
	`channelId` text,
	`message` text,
	`startTime` text,
	`recurrence` text,
	`status` text,
	`notificationOffsets` text,
	`selectedEmojis` text,
	`hideNextTime` integer DEFAULT false,
	`nextNotificationTime` text,
	`nextOffsetIndex` integer,
	`order` integer
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`channels` text,
	`channelsFetchedAt` integer,
	`passwordHash` text,
	`customName` text,
	`customIcon` text,
	`serverType` text DEFAULT 'normal'
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`avatar` text,
	`accessToken` text,
	`refreshToken` text,
	`guilds` text,
	`subscriptionStatus` text,
	`expiresAt` text
);
