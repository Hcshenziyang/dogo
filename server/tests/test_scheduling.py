from datetime import datetime

import pytest
from conftest import device, login, receipt
from test_mcp import tool

from dogo_server.domain.errors import DomainError
from dogo_server.domain.plans import PlanConfig
from dogo_server.interfaces.commands import dispatch_ack
from dogo_server.interfaces.schemas import DispatchAck


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


@pytest.mark.parametrize(
    "mode,options,start,expected",
    [
        ("daily", {}, "2026-11-03T09:00:00+08:00", "2026-11-04T09:00:00+08:00"),
        ("weekly", {"weekday": 0}, "2026-11-03T12:00:00+08:00", "2026-11-09T09:00:00+08:00"),
        ("monthly", {"day": 31}, "2027-02-01T00:00:00+08:00", "2027-02-28T09:00:00+08:00"),
        ("monthly", {"day": 31}, "2028-02-01T00:00:00+08:00", "2028-02-29T09:00:00+08:00"),
        (
            "daily",
            {"timezone": "America/New_York", "time": "02:30"},
            "2026-03-08T00:00:00-05:00",
            "2026-03-09T02:30:00-04:00",
        ),
        (
            "daily",
            {"timezone": "America/New_York", "time": "01:30"},
            "2026-11-01T01:31:00-04:00",
            "2026-11-02T01:30:00-05:00",
        ),
    ],
)
def test_calendar_rules(mode, options, start, expected):
    plan = PlanConfig(mode=mode, instruction="整理", target_device_id="pc", **options)
    assert plan.next_after(stamp(start)) == stamp(expected)


@pytest.mark.parametrize(
    "options",
    [
        {"mode": "weekly"},
        {"mode": "monthly", "day": 32},
        {"mode": "daily", "timezone": "Unknown/Zone"},
        {"mode": "daily", "time": "25:00"},
        {"mode": "daily", "run_at": 1},
        {"mode": "once"},
    ],
)
def test_invalid_rules(options):
    with pytest.raises(DomainError, match="Invalid execution plan"):
        PlanConfig(instruction="整理", target_device_id="pc", **options)


@pytest.fixture
def scheduled(client, app, headers):
    from dogo_server.application.scheduling import ScheduleService

    c = app.state.container
    clock = [stamp("2026-11-03T08:00:00+08:00")]
    # The running background scanner retains the original instance; keep its clock
    # before all test schedules and drive a separate scanner deterministically.
    original = c.scheduler
    original.clock = lambda: 0
    c.scheduler = ScheduleService(
        c.uow, clock=lambda: clock[0], new_id=original.new_id, notify=original.notify
    )
    c.memos.clock = c.deliveries.clock = lambda: clock[0]
    target, bound = device(client, headers)
    p = c.identity.bearer(bound["Authorization"])

    def create(**changes):
        plan = {
            "mode": "daily",
            "instruction": "整理本周记录",
            "target_device_id": target["id"],
            **changes,
        }
        response = client.post(
            "/api/memos",
            headers=headers,
            json={"request_id": "plan-1", "content": "计划正文", "project": "工作", "plan": plan},
        )
        assert response.status_code == 201, response.text
        return response.json(), plan

    def get(memo):
        return client.get("/api/memos/" + memo["id"], headers=headers).json()

    def update(memo, **changes):
        fields = {
            k: memo[k] for k in ("content", "project", "category", "tags", "active", "revision")
        }
        return client.put("/api/memos/" + memo["id"], headers=headers, json={**fields, **changes})

    def ack(d):
        return c.deliveries.acknowledge(p, dispatch_ack(DispatchAck(**receipt(d))))

    return c, clock, p, create, get, update, ack


def test_once_coalesces_recovers_and_ack_is_idempotent(scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, config = create(mode="once", run_at=clock[0] + 1000)
    assert c.scheduler.tick() == 0
    clock[0] += 1000
    c.scheduler.tick()
    queued = get(memo)
    assert queued["dispatch"]["status"] == "pending" and queued["next_run_at"] is None
    # Restart the composition root against the exact same DB; no extra dispatch is generated.
    from dogo_server.bootstrap import create_container

    restarted = create_container(c.settings)
    assert restarted.scheduler.tick() == 0
    d = c.deliveries.next_delivery(p)
    replay = c.deliveries.next_delivery(p)
    assert (d["id"], d["lease_token"]) == (replay["id"], replay["lease_token"])
    ack(d)
    clock[0] += 5 * 86400000
    ack(d)
    assert c.scheduler.tick() == 0
    assert get(memo)["dispatch"]["status"] == "accepted"
    assert get(memo)["next_run_at"] is None


def test_periodic_misses_only_one_then_keeps_original_time(scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, _ = create()
    clock[0] = stamp("2026-11-03T10:00:00+08:00")
    c.scheduler.tick()
    first = get(memo)["dispatch"]["id"]
    clock[0] = stamp("2026-11-06T11:00:00+08:00")
    for _ in range(3):
        c.scheduler.tick()
    assert get(memo)["dispatch"]["id"] == first
    d = c.deliveries.next_delivery(p)
    ack(d)
    assert get(memo)["next_run_at"] == stamp("2026-11-07T09:00:00+08:00")
    clock[0] = stamp("2026-11-07T10:00:00+08:00")
    ack(d)  # A late duplicate must not skip the next due occurrence.
    assert get(memo)["next_run_at"] == stamp("2026-11-07T09:00:00+08:00")
    c.scheduler.tick()
    assert get(memo)["dispatch"]["id"] != first
    assert get(memo)["revision"] == 1


def test_plan_edit_pause_resume_remove_and_legacy_update(scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, config = create()
    original_id = memo["plan"]["id"]
    saved = update(memo, content="旧客户端只改正文").json()
    assert saved["plan"]["id"] == original_id
    clock[0] += 86400000
    c.scheduler.tick()
    queued = get(memo)
    with c.uow() as uow:
        assert (
            uow.dispatches.for_memo(p.account_id, memo["id"])[0].content.content_snapshot
            == "旧客户端只改正文"
        )
    paused = update(queued, plan={**config, "enabled": False}).json()
    assert paused["dispatch"]["status"] == "cancelled" and paused["next_run_at"] is None
    clock[0] += 86400000 * 5
    resumed = update(paused, plan=config).json()
    assert resumed["plan"]["id"] != original_id
    assert resumed["next_run_at"] > clock[0]
    removed = update(resumed, plan=None).json()
    assert "plan" not in removed
    clock[0] += 86400000
    assert c.scheduler.tick() == 0


def test_leased_edit_rejected_pause_does_not_recall_and_old_ack_cannot_advance(scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, config = create(mode="once", run_at=clock[0])
    c.scheduler.tick()
    d = c.deliveries.next_delivery(p)
    assert update(memo, plan={**config, "instruction": "改写"}).status_code == 409
    assert update(memo, plan=None).status_code == 409
    paused = update(get(memo), plan={**config, "enabled": False}).json()
    ack(d)
    assert get(memo)["next_run_at"] is None
    resumed = update(paused, plan=config).json()
    assert resumed["next_run_at"] is None  # It was accepted while paused; don't run twice.
    assert c.scheduler.tick() == 0
    paused_again = update(resumed, plan={**config, "enabled": False}).json()
    resumed = update(paused_again, plan=config).json()
    assert resumed["next_run_at"] is None
    changed = update(resumed, plan={**config, "run_at": clock[0] + 1000}).json()
    clock[0] += 1000
    c.scheduler.tick()
    ack(d)
    assert get(memo)["plan"]["id"] == changed["plan"]["id"]
    assert get(memo)["dispatch"]["status"] == "pending"


def test_memo_inactive_stops_plan_and_resume_skips_paused_cycles(scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, _ = create()
    stopped = update(memo, active=False).json()
    clock[0] += 86400000 * 5
    assert c.scheduler.tick() == 0
    resumed = update(stopped, active=True).json()
    assert resumed["next_run_at"] > clock[0]


def test_plan_isolation_and_mcp_share_rules(client, headers, scheduled):
    c, clock, p, create, get, update, ack = scheduled
    foreign, _ = device(client, {"Authorization": "Bearer " + login(client, "bob")["access_token"]})
    result = tool(
        client,
        headers,
        "create_memo",
        {
            "data": {
                "request_id": "mcp-plan",
                "content": "MCP",
                "plan": {
                    "mode": "once",
                    "run_at": clock[0],
                    "instruction": "整理",
                    "target_device_id": foreign["id"],
                },
            }
        },
    )
    assert result["isError"] and "not_found" in result["content"][0]["text"]
    memo, config = create()
    result = tool(
        client,
        headers,
        "update_memo",
        {
            "memo_id": memo["id"],
            "data": {"content": "MCP修改", "revision": 1, "plan": {**config, "time": "10:00"}},
        },
    )
    assert not result.get("isError")
    assert get(memo)["next_run_at"] == stamp("2026-11-03T10:00:00+08:00")


def test_scheduler_rolls_back_both_dispatch_and_cursor(scheduled, monkeypatch):
    c, clock, p, create, get, update, ack = scheduled
    memo, _ = create(mode="once", run_at=clock[0])
    from dogo_server.infrastructure.sqlite.repositories import SQLiteMemoRepository

    original = SQLiteMemoRepository.save

    def fail(*args):
        raise RuntimeError("simulated disk failure")

    monkeypatch.setattr(SQLiteMemoRepository, "save", fail)
    with pytest.raises(RuntimeError):
        c.scheduler.tick()
    assert get(memo)["dispatch"] is None and get(memo)["next_run_at"] == clock[0]
    monkeypatch.setattr(SQLiteMemoRepository, "save", original)
    c.scheduler.tick()
    assert get(memo)["dispatch"]["status"] == "pending"


def test_parallel_scans_generate_only_one_occurrence(scheduled):
    from concurrent.futures import ThreadPoolExecutor

    c, clock, p, create, get, update, ack = scheduled
    memo, _ = create(mode="once", run_at=clock[0])
    with ThreadPoolExecutor(max_workers=8) as pool:
        counts = list(pool.map(lambda _: c.scheduler.tick(), range(16)))
    assert sum(counts) == 1
    with c.uow() as uow:
        assert len(uow.dispatches.for_memo(p.account_id, memo["id"])) == 1


def test_connected_device_wakes_when_scheduled_time_arrives(client, headers):
    import time

    target, bound = device(client, headers)
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        created = client.post(
            "/api/memos",
            headers=headers,
            json={
                "request_id": "auto-schedule",
                "content": "自动触发",
                "plan": {
                    "mode": "once",
                    "run_at": int(time.time() * 1000) + 200,
                    "instruction": "处理",
                    "target_device_id": target["id"],
                },
            },
        )
        assert created.status_code == 201
        frame = ws.receive_json()
        assert frame["type"] == "dispatch"
        assert frame["dispatch"]["content_snapshot"] == "自动触发"
        ws.send_json(receipt(frame["dispatch"]))
        assert ws.receive_json()["type"] == "dispatch.acknowledged"


def test_disabled_device_waits_until_it_is_enabled_again(client, headers, scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, plan = create(mode="once", run_at=clock[0] + 1000)
    assert (
        client.delete("/api/devices/" + plan["target_device_id"], headers=headers).status_code
        == 200
    )
    clock[0] += 2000
    assert c.scheduler.tick() == 0
    assert get(memo)["next_run_at"] < clock[0]
    login(client, device_id=plan["target_device_id"], name="Desktop", kind="desktop")
    assert c.scheduler.tick() == 1
    assert get(memo)["dispatch"]["status"] == "pending"


def test_v2_upgrade_failure_rolls_back_schema_and_data(tmp_path, monkeypatch):
    import sqlite3
    from pathlib import Path

    from dogo_server.infrastructure.sqlite import database

    path = tmp_path / "rollback.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript((Path(__file__).parent / "fixtures/v2.sql").read_text())
        db.execute("INSERT INTO accounts VALUES ('account','user','hash',1,1)")
    monkeypatch.setattr(
        database, "SCHEDULE_MIGRATION", database.SCHEDULE_MIGRATION + "\nINVALID SQL;"
    )
    with pytest.raises(sqlite3.OperationalError):
        database.Database(path).initialize()
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
        assert "plan" not in [r[1] for r in db.execute("PRAGMA table_info(memos)")]
        assert db.execute("SELECT username FROM accounts").fetchone()[0] == "user"


def test_once_accepted_while_memo_inactive_is_not_replayed_on_reactivation(scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, config = create(mode="once", run_at=clock[0])
    c.scheduler.tick()
    dispatch = c.deliveries.next_delivery(p)
    assert update(memo, active=False, plan={**config, "instruction": "改写"}).status_code == 409
    inactive = update(memo, active=False).json()
    ack(dispatch)
    resumed = update(inactive, active=True).json()
    assert resumed["next_run_at"] is None
    assert c.scheduler.tick() == 0


def test_recurring_plan_catches_up_once_when_service_was_down(scheduled):
    from dogo_server.bootstrap import create_container

    c, clock, p, create, get, update, ack = scheduled
    memo, _ = create()
    stopped_at = clock[0]
    c.scheduler.clock = lambda: stopped_at  # The first service is no longer scheduling.
    clock[0] += 86400000 * 4
    restarted = create_container(c.settings)
    restarted.scheduler.clock = restarted.deliveries.clock = lambda: clock[0]
    assert restarted.scheduler.tick() == 1
    assert restarted.scheduler.tick() == 0
    dispatch = restarted.deliveries.next_delivery(p)
    restarted.deliveries.acknowledge(p, dispatch_ack(DispatchAck(**receipt(dispatch))))
    assert get(memo)["next_run_at"] > clock[0]
    assert get(memo)["dispatch"]["status"] == "accepted"


def test_scheduled_create_retry_is_idempotent_and_changed_input_is_rejected(
    client, headers, scheduled
):
    c, clock, p, create, get, update, ack = scheduled
    memo, plan = create(mode="once", run_at=clock[0])
    payload = {"request_id": "plan-1", "content": "计划正文", "project": "工作", "plan": plan}
    c.scheduler.tick()
    again = client.post("/api/memos", headers=headers, json=payload)
    assert again.status_code == 201
    assert again.json()["id"] == memo["id"]
    assert again.json()["dispatch"]["status"] == "pending"
    changed = client.post(
        "/api/memos", headers=headers, json={**payload, "plan": {**plan, "instruction": "不同指令"}}
    )
    assert changed.status_code == 409
    assert c.scheduler.tick() == 0


def test_pause_with_whitespace_in_original_instruction_keeps_the_inflight_plan(scheduled):
    c, clock, p, create, get, update, ack = scheduled
    memo, config = create(mode="once", run_at=clock[0], instruction="  保留空格\n")
    c.scheduler.tick()
    dispatch = c.deliveries.next_delivery(p)
    paused = update(memo, plan={**config, "enabled": False})
    assert paused.status_code == 200
    assert paused.json()["plan"]["id"] == memo["plan"]["id"]
    assert paused.json()["plan"]["instruction"] == "  保留空格\n"
    ack(dispatch)


def test_adding_or_pausing_plan_does_not_cancel_existing_immediate_work(client, headers, scheduled):
    c, clock, p, create, get, update, ack = scheduled
    target, _ = device(client, headers)
    created = client.post(
        "/api/memos",
        headers=headers,
        json={
            "request_id": "separate-actions",
            "content": "备忘",
            "dispatch": {"instruction": "立即指令", "target_device_id": target["id"]},
        },
    ).json()
    plan = {
        "mode": "once",
        "run_at": clock[0],
        "instruction": "定时指令",
        "target_device_id": target["id"],
    }
    updated = update(created, plan=plan)
    assert updated.status_code == 200
    c.scheduler.tick()
    with c.uow() as uow:
        records = uow.dispatches.open_for_memo(p.account_id, created["id"])
        assert sorted(d.content.instruction for d in records) == ["定时指令", "立即指令"]
    paused = update(get(created), plan={**plan, "enabled": False})
    assert paused.status_code == 200
    with c.uow() as uow:
        records = uow.dispatches.open_for_memo(p.account_id, created["id"])
        assert [d.content.instruction for d in records] == ["立即指令"]
