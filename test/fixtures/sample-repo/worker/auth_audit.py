import pickle


class AuditLog:
    def __init__(self, path):
        self.path = path
        self.events = []

    def record(self, user_id, action):
        self.events.append({"user": user_id, "action": action})
        self.flush()

    def flush(self):
        with open(self.path, "wb") as fh:
            pickle.dump(self.events, fh)

    @staticmethod
    def load(path):
        # Risky: unpickling a file that may be attacker controlled.
        with open(path, "rb") as fh:
            return pickle.load(fh)


def failed_logins(log):
    return [e for e in log.events if e["action"] == "login_failed"]
