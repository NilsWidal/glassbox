# sample-repo

A small TypeScript web app with a Python worker. It exists as a test fixture
for glassbox. Some of the code is deliberately risky (weak hashing, SQL built
from strings, a skipped auth check) so questions have real answers.

Areas: auth (src/auth, worker/auth_audit.py), billing (src/billing,
worker/billing_sync.py), ui (src/ui).
