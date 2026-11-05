package app.dogo.mobile;

import org.json.JSONObject;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.time.temporal.ChronoUnit;

/** Editable local representation; only validated schedule fields go over the wire. */
final class ScheduleDraft {
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm")
            .withResolverStyle(ResolverStyle.STRICT);
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm")
            .withResolverStyle(ResolverStyle.STRICT);
    static JSONObject fromPlan(JSONObject plan) {
        String zone = plan == null ? "Asia/Shanghai" : plan.optString("timezone", "Asia/Shanghai");
        LocalDateTime date = plan != null && !plan.isNull("run_at")
                ? LocalDateTime.ofInstant(Instant.ofEpochMilli(plan.optLong("run_at")), ZoneId.of(zone))
                : LocalDateTime.now(ZoneId.of(zone)).plusHours(1).truncatedTo(ChronoUnit.MINUTES);
        return Json.of("instruction", plan == null ? "" : plan.optString("instruction"),
                "target_device_id", plan == null ? "" : plan.optString("target_device_id"),
                "mode", plan == null ? "once" : plan.optString("mode", "once"),
                "enabled", plan == null || plan.optBoolean("enabled", true),
                "timezone", zone, "run_at_input", DATE.format(date),
                "time", plan == null ? "09:00" : plan.optString("time", "09:00"),
                "weekday", plan == null ? 0 : plan.optInt("weekday", 0),
                "day", plan == null ? 1 : plan.optInt("day", 1));
    }
    static JSONObject payload(JSONObject input) {
        String instruction = input.optString("instruction");
        String target = input.optString("target_device_id");
        String mode = input.optString("mode");
        String zoneName = input.optString("timezone", "Asia/Shanghai");
        String time = input.optString("time", "09:00");
        if (instruction.trim().isEmpty() || target.isEmpty())
            throw new IllegalArgumentException("请填写定时指令并选择目标电脑。");
        if (!java.util.Arrays.asList("once", "daily", "weekly", "monthly").contains(mode))
            throw new IllegalArgumentException("请选择执行频率。");
        JSONObject result = Json.of("instruction", instruction, "target_device_id", target,
                "mode", mode, "enabled", input.optBoolean("enabled", true), "timezone", zoneName,
                "time", time);
        try {
            ZoneId zone = ZoneId.of(zoneName);
            java.time.LocalTime.parse(time, TIME);
            if (mode.equals("once")) {
                LocalDateTime date = LocalDateTime.parse(input.optString("run_at_input"), DATE);
                java.util.List<java.time.ZoneOffset> offsets = zone.getRules().getValidOffsets(date);
                if (offsets.isEmpty()) throw new IllegalArgumentException();
                Json.put(result, "run_at", date.toInstant(offsets.get(0)).toEpochMilli());
            }
            if (mode.equals("weekly")) Json.put(result, "weekday", input.optInt("weekday", 0));
            if (mode.equals("monthly")) Json.put(result, "day", input.optInt("day", 1));
        } catch (Exception error) {
            throw new IllegalArgumentException("请检查执行日期和时间，格式为 2026-11-03 20:00。");
        }
        return result;
    }
}
