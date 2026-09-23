"""Behaviour checks for the tomli tasks: python3 check.py <case>."""
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), "src"))
import tomli  # noqa: E402

case = sys.argv[1]
if case == "literal":
    got = tomli.loads("a = 'x'\nb = 'C:\\\\path'\n")
    assert got == {"a": "x", "b": "C:\\\\path"}, got
elif case == "false":
    got = tomli.loads("a = false\nb = true\nc = [false, true]\n")
    assert got == {"a": False, "b": True, "c": [False, True]}, got
elif case == "surrogate":
    try:
        tomli.loads('a = "\\uD800"')
    except tomli.TOMLDecodeError:
        pass
    else:
        raise AssertionError("a surrogate escape must raise TOMLDecodeError")
    assert tomli.loads('a = "\\u00E9"') == {"a": "\u00e9"}
elif case == "crlf":
    got = tomli.loads("a = 1\r\nb = 'x'\r\n[t]\r\nc = 2\r\n")
    assert got == {"a": 1, "b": "x", "t": {"c": 2}}, got
else:
    raise SystemExit(f"unknown case {case}")
