// Whole phrases, so the number sits where Chinese puts it.
export default {
  "just now": "刚刚",
  "{count}m ago": "{count} 分钟前",
  "{count}h ago": "{count} 小时前",
  "{count}d ago": "{count} 天前",
  now: "刚刚",
  "{count}m": "{count} 分钟",
  "{count}h": "{count} 小时",
  "{count}d": "{count} 天",
  // A snoozed thread's time left once it is due; "now" alone means "just now".
  "time remaining|now": "马上",
} satisfies Record<string, string>;
