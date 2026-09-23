"""Behaviour checks for the schedule tasks: python3 check.py <case>."""
import datetime
import os
import sys

sys.path.insert(0, os.getcwd())
import schedule  # noqa: E402

case = sys.argv[1]
s = schedule.Scheduler()
if case == "get-jobs":
    a = s.every().hour.do(print).tag("reports")
    s.every().hour.do(print).tag("other")
    assert s.get_jobs("reports") == [a], s.get_jobs("reports")
    assert len(s.get_jobs()) == 2
elif case == "idle":
    s.every(10).minutes.do(print)
    idle = s.idle_seconds
    assert idle is not None and 0 < idle <= 600, idle
elif case == "weekday":
    moment = datetime.datetime(2024, 5, 20, 9, 0)  # a Monday
    got = schedule._move_to_next_weekday(moment, "monday")
    assert got == moment, got
    got = schedule._move_to_next_weekday(moment, "sunday")
    assert got == datetime.datetime(2024, 5, 26, 9, 0), got
elif case == "tags":
    s.every().hour.do(print).tag("a", "b")
    s.every().hour.do(print).tag("b", "c")
    assert s.get_tags() == {"a", "b", "c"}, s.get_tags()
    assert schedule.Scheduler().get_tags() == set()
    schedule.clear()
    schedule.every().hour.do(print).tag("x")
    assert schedule.get_tags() == {"x"}, schedule.get_tags()
    schedule.clear()
else:
    raise SystemExit(f"unknown case {case}")
