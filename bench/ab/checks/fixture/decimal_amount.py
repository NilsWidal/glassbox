import os
import sys
from decimal import Decimal

sys.path.insert(0, os.getcwd())
from worker.utils import parse_amount  # noqa: E402

r = parse_amount("$1,234.10")
assert isinstance(r, Decimal), f"parse_amount should return Decimal, got {type(r).__name__}"
assert r == Decimal("1234.10"), f"parse_amount('$1,234.10') gave {r!r}"
assert parse_amount("0.1") + parse_amount("0.2") == Decimal("0.3"), "0.1 + 0.2 should be exactly 0.3"
