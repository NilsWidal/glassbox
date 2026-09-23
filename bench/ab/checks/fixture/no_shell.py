import os
import subprocess
import sys

sys.path.insert(0, os.getcwd())
import worker.billing_sync as bs  # noqa: E402

calls = []


class Done:
    stdout = "inv1,10.00\n"
    returncode = 0


def fake_run(*args, **kwargs):
    calls.append((args, kwargs))
    return Done()


subprocess.run = fake_run
bs.subprocess.run = fake_run
nasty = "c1; rm -rf /"
bs.fetch_invoices(nasty)
assert calls, "fetch_invoices should still call subprocess.run"
args, kwargs = calls[0]
cmd = args[0] if args else kwargs.get("args")
assert not kwargs.get("shell"), "fetch_invoices must not use shell=True"
assert isinstance(cmd, (list, tuple)), f"the command should be a list, got {type(cmd).__name__}"
assert nasty in cmd, f"customer_id should be passed as one argument, got {cmd!r}"
