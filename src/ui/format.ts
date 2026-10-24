/** 展示层格式化工具 */

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 / 具体日期 */
export function formatRelativeTime(timestamp: number, base = Date.now()): string {
  const diff = base - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(base).getFullYear();
  const month = date.getMonth() + 1;
  const dayOfMonth = date.getDate();
  return sameYear ? `${month} 月 ${dayOfMonth} 日` : `${date.getFullYear()} 年 ${month} 月`;
}

/** 字数：不足一万按整数，超过按「x.x 万」 */
export function formatWordCount(count: number): string {
  if (count < 10_000) return `${count} 字`;
  return `${(count / 10_000).toFixed(1)} 万字`;
}
