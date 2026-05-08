UPDATE reminders 
SET eventTime = datetime(nextNotificationTime, '+' || coalesce(json_extract(notificationOffsets, '$[' || coalesce(nextOffsetIndex, 0) || ']'), 0) || ' minutes')
WHERE eventTime IS NULL AND nextNotificationTime IS NOT NULL;
