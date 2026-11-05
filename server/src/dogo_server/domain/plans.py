"""Calendar rules and durable plan identity, independent of clocks and transports."""

import calendar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .errors import DomainError


@dataclass(frozen=True, kw_only=True)
class PlanConfig:
    instruction: str
    target_device_id: str
    mode: str
    enabled: bool = True
    timezone: str = "Asia/Shanghai"
    run_at: int | None = None
    time: str = "09:00"
    weekday: int | None = None  # Monday = 0
    day: int | None = None

    def __post_init__(self):
        try:
            ZoneInfo(self.timezone)
            hour, minute = map(int, self.time.split(":"))
            valid = (
                self.time == f"{hour:02d}:{minute:02d}"
                and 0 <= hour < 24
                and 0 <= minute < 60
                and self.mode in {"once", "daily", "weekly", "monthly"}
                and 1 <= len(self.instruction.strip()) <= 32_000
                and 1 <= len(self.target_device_id) <= 128
                and (
                    (isinstance(self.run_at, int) and 0 < self.run_at < 253_370_764_800_000)
                    if self.mode == "once"
                    else self.run_at is None
                )
                and (self.weekday is not None) == (self.mode == "weekly")
                and (self.weekday is None or 0 <= self.weekday <= 6)
                and (self.day is not None) == (self.mode == "monthly")
                and (self.day is None or 1 <= self.day <= 31)
            )
            if not valid:
                raise ValueError("Invalid rule")
        except (ValueError, TypeError, ZoneInfoNotFoundError):
            raise DomainError("invalid_plan", "Invalid execution plan or timezone") from None

    def next_after(self, now: int) -> int | None:
        """First calendar occurrence strictly after now; skip missing DST wall times."""
        if self.mode == "once":
            return None
        zone = ZoneInfo(self.timezone)
        start = datetime.fromtimestamp(now / 1000, UTC).astimezone(zone).date()
        hour, minute = map(int, self.time.split(":"))
        for offset in range(400):
            date = start + timedelta(days=offset)
            if self.mode == "weekly" and date.weekday() != self.weekday:
                continue
            if self.mode == "monthly" and date.day != min(
                self.day, calendar.monthrange(date.year, date.month)[1]
            ):
                continue
            candidate = datetime(date.year, date.month, date.day, hour, minute, tzinfo=zone)
            # fold=0 chooses the first of two repeated wall times. Round-trip rejects DST gaps.
            stamp = int(candidate.timestamp() * 1000)
            if datetime.fromtimestamp(stamp / 1000, zone).replace(tzinfo=None) != candidate.replace(
                tzinfo=None
            ):
                continue
            if stamp > now:
                return stamp
        raise DomainError("invalid_plan", "No calendar occurrence could be calculated")

    def first_run(self, now: int) -> int | None:
        if not self.enabled:
            return None
        return self.run_at if self.mode == "once" else self.next_after(now)


@dataclass(frozen=True)
class ExecutionPlan:
    id: str
    config: PlanConfig
