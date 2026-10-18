/** The engine's `listening.calendar` answer. */
export interface Calendar {
  today: string;
  days: Array<{ date: string; plays: number; minutes: number }>;
  month: string;
  month_minutes: number;
  month_plays: number;
  top_artists: Array<{ name: string; minutes: number; plays: number }>;
}

export interface Grid {
  /** `cells[weekday][week]`: minutes listened, 0 for a quiet day, null after today. */
  cells: Array<Array<number | null>>;
  /** The column where each month begins, with its short name. */
  months: Array<{ week: number; label: string }>;
  total: { minutes: number; plays: number; days: number };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}
const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * Lay the last `weeks` weeks out as a GitHub-style grid: one column per week,
 * Monday at the top, ending with the week that holds `today`.
 */
export function calendarGrid(calendar: Calendar, weeks: number): Grid {
  const today = parseDate(calendar.today) ?? new Date();
  const byDay = new Map(calendar.days.map(day => [day.date, day]));
  const weekday = (today.getDay() + 6) % 7;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekday - (weeks - 1) * 7);
  const cells = Array.from({ length: 7 }, () => Array<number | null>(weeks).fill(null));
  const months: Grid["months"] = [];
  const total = { minutes: 0, plays: 0, days: 0 };
  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + week * 7 + day);
      if (date > today) continue;
      const entry = byDay.get(key(date));
      cells[day]![week] = entry?.minutes ?? 0;
      if (entry) { total.minutes += entry.minutes; total.plays += entry.plays; total.days++; }
      // A month is named over the week it begins in; one beginning inside the
      // first week takes that column from the month the grid opens in.
      if (date.getDate() === 1 || (week === 0 && day === 0)) {
        const label = MONTHS[date.getMonth()]!, existing = months.find(month => month.week === week);
        if (existing) existing.label = label; else months.push({ week, label });
      }
    }
  }
  return { cells, months, total };
}

/**
 * Five shades: none, then four steps split at the quartiles of the days that
 * had any listening, so one long day cannot wash out the rest of the year.
 */
export function intensityScale(grid: Grid): (minutes: number | null) => number {
  const active = grid.cells.flat().filter((value): value is number => value !== null && value > 0).sort((a, b) => a - b);
  const at = (fraction: number) => active[Math.min(active.length - 1, Math.floor(fraction * active.length))] ?? 0;
  const bounds = [at(0.25), at(0.5), at(0.75)];
  return minutes => {
    if (minutes === null || minutes <= 0) return 0;
    return 1 + bounds.filter(bound => minutes > bound).length;
  };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
}

/** Month label for "2026-10". */
export function monthName(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(match[2]) - 1]} ${match[1]}` : month;
}
