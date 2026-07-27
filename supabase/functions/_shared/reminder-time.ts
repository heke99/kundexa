export function localMinutes(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function inQuietHours(date: Date, timezone: string, start: string, end: string) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const current = localMinutes(date, timezone);
  const from = startHour * 60 + startMinute;
  const to = endHour * 60 + endMinute;
  return from < to ? current >= from && current < to : current >= from || current < to;
}
