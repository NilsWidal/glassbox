import worker.utils as u
from worker.auth_audit import AuditLog, failed_logins
from .billing_sync import sync_invoices


def run(customer_id):
    log = AuditLog("/tmp/audit.pkl")
    total = sync_invoices(customer_id)
    log.record(customer_id, "sync")
    print(u.parse_amount(str(total)), len(failed_logins(log)))


if __name__ == "__main__":
    run("c1")
