const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function CommentDate({ createdAt }: { createdAt: number | string }) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time className="whitespace-nowrap text-muted" dateTime={date.toISOString()} title={date.toLocaleString()}>
      {format.format(date)}
    </time>
  );
}
