import json
import threading
import time
import urllib.request


class BridgeClient:
    def __init__(self, connection, application):
        self.url = connection["url"]
        self.token = connection["token"]
        self.application = application
        self.instance_id = None
        self.handlers = {}
        self.thread = None
        self.stopping = threading.Event()

    @classmethod
    def from_connection_file(cls, connection_file, application):
        with open(connection_file, encoding="utf-8") as stream:
            return cls(json.load(stream), application)

    def _body(self, extra=None):
        value = {
            "token": self.token,
            "app_id": self.application["id"],
            "adapter": self.application["adapter"],
            "version_sha256": self.application["version_sha256"],
            "reproduction_id": self.application["reproduction_id"],
        }
        if self.instance_id:
            value["instance_id"] = self.instance_id
        value.update(extra or {})
        return value

    def _post(self, route, body):
        request = urllib.request.Request(
            self.url + route,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def expose(self, name, handler):
        if self.instance_id:
            raise RuntimeError("state handlers must be exposed before connect")
        self.handlers[name] = handler
        return self

    def connect(self):
        if not self.instance_id:
            result = self._post("/v1/register", self._body({"exposed_state": list(self.handlers)}))
            self.instance_id = result["instance_id"]
        return self.instance_id

    def event(self, kind, message, data=None, level=None):
        if not self.instance_id:
            raise RuntimeError("bridge client is not connected")
        return self._post("/v1/event", self._body({
            "kind": kind,
            "level": level,
            "message": str(message),
            "data": data,
            "client_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }))

    def poll(self):
        if not self.instance_id:
            return
        for command in self._post("/v1/poll", self._body())["commands"]:
            handler = self.handlers.get(command["name"])
            try:
                if handler is None:
                    raise RuntimeError("state handler unavailable")
                response = {"value": handler()}
            except Exception as error:
                response = {"error": str(error)}
            try:
                self._post("/v1/state", self._body({"request_id": command["request_id"], **response}))
            except Exception:
                continue

    def start_polling(self, interval_seconds=0.1):
        if self.thread:
            return
        self.stopping.clear()

        def run():
            while not self.stopping.wait(interval_seconds):
                try:
                    self.poll()
                except Exception:
                    if not self.stopping.is_set():
                        time.sleep(interval_seconds)

        self.thread = threading.Thread(target=run, name="omd-bridge", daemon=True)
        self.thread.start()

    def close(self):
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=2)
            self.thread = None
        if self.instance_id:
            self._post("/v1/disconnect", self._body())
            self.instance_id = None
