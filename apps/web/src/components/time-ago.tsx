import { timeAgo } from '@/lib/format';

export function TimeAgo({ date }: { date: Date }) {
  return (
    <time dateTime={date.toISOString()} title={date.toUTCString()}>
      {timeAgo(date)}
    </time>
  );
}
