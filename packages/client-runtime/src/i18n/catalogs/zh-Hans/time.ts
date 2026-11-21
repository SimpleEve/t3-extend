// Whole phrases, so the number sits where Chinese puts it.
export default {
  "just now": "刚刚",
  "{count}m ago": "{count} 分钟前",
  "{count}h ago": "{count} 小时前",
  "{count}d ago": "{count} 天前",
  now: "现在",
  "{count}m": "{count} 分钟",
  "{count}h": "{count} 小时",
  "{count}d": "{count} 天",
  "{count}s": "{count} 秒",
  // A snoozed thread's time left once it is due; "now" alone means "just now".
  "time remaining|now": "马上",
  "yesterday at {time}": "昨天 {time}",
  "tomorrow at {time}": "明天 {time}",
  // Pairing link lifetime on Settings → Sharing & access.
  Expired: "已过期",
  "Expires in a moment": "即将过期",
  "Expires in {duration}": "{duration} 后过期",
} satisfies Record<string, string>;
