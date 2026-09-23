import time


def with_retry(fn, attempts=3):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as err:  # noqa: BLE001
            last = err
            time.sleep(2 ** i * 0.1)
    raise last


def parse_amount(text):
    # Risky: float parsing for money.
    return float(text.replace("$", "").replace(",", ""))
