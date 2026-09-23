import subprocess

from .utils import with_retry, parse_amount


def fetch_invoices(customer_id):
    # Risky: shell=True with caller-controlled input.
    out = subprocess.run(
        "billing-cli export --customer " + customer_id, shell=True, capture_output=True, text=True
    )
    return [line.split(",") for line in out.stdout.splitlines()]


def sync_invoices(customer_id):
    rows = with_retry(lambda: fetch_invoices(customer_id))
    return sum(parse_amount(row[1]) for row in rows if len(row) > 1)
