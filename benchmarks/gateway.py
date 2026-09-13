import http.client
import http.server
import json
import os
import secrets
import socket
import threading
import time
import uuid
from decimal import Decimal
from urllib.parse import urlsplit

from .compare import estimate_tokens, number, put, require, write


class Budget:

    def __init__(self, limits, output):
        for key in ("seconds", "requests", "max_output_tokens", "max_request_bytes", "max_response_bytes"):
            require(type(limits[key]) is int and limits[key] > 0, f"invalid limit: {key}")
        self.limits, self.output = limits, output
        self.started = time.monotonic()
        self.count, self.reserved = 0, Decimal(0)
        self.lock = threading.Lock()

    def admit(self, exposure):
        with self.lock:
            require(time.monotonic() - self.started < self.limits["seconds"], "experiment time exhausted")
            require(self.count < self.limits["requests"], "experiment request count exhausted")
            amount = number(exposure)
            require(self.reserved + amount <= number(self.limits["usd_exposure"]), "experiment exposure exhausted")
            self.count += 1
            self.reserved += amount

            write(self.output / f"admission-{self.count:06d}.json",
                  {"requests": self.count, "reserved_usd": str(self.reserved),
                   "elapsed_seconds": time.monotonic() - self.started})

    def remaining_seconds(self):
        return max(0, self.limits["seconds"] - (time.monotonic() - self.started))


def validate_routes(routes, fixture):
    require(routes, "provider routes required")
    for name, route in routes.items():
        require(name.isidentifier(), "route name must be an identifier")
        url = urlsplit(route["url"])
        require(not url.username and not url.password and not url.query and not url.fragment, "unsafe provider URL")
        if fixture:
            require(url.scheme == "http" and url.hostname == "127.0.0.1", "fixtures permit loopback HTTP only")
        else:
            require(url.scheme == "https", "live provider requires HTTPS")
            require(route.get("credential_env") and os.environ.get(route["credential_env"]), "provider credential unavailable")
            require(number(route["request_exposure_usd"]) > 0, "live requests require a conservative exposure reservation")
        require(route["models"] and route["account_alias"], "provider model/account declaration required")
        require(route["billing"] in ("unknown", "subscription", "estimate"), "invalid route billing mode")
        if route["billing"] == "estimate":
            require(route.get("rates") and route.get("rate_card"), "rate-card evidence required")


class Gateway:
    def __init__(self, routes, budget, output, scope="task_api", fixture=False):
        validate_routes(routes, fixture)
        self.routes, self.budget, self.output, self.scope = routes, budget, output, scope
        self.token = secrets.token_urlsafe(32)
        self.records, self.connections = [], set()
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                self.send_error(404)

            def do_POST(self):
                owner.handle(self)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self):
        return self.server.server_port

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stopped.set()
        self.server.shutdown()
        with self.lock:
            for connection in self.connections:
                if connection.sock:
                    try:
                        connection.sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                connection.close()

        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            with self.lock:
                if all(r.get("finished") for r in self.records):
                    break
            time.sleep(0.02)
        self.server.server_close()
        self.thread.join(timeout=2)
        with self.lock:
            for record in self.records:
                if not record.get("finished"):
                    record["error"] = "request still in flight at collection cutoff"

    def handle(self, client):
        uid = uuid.uuid4().hex
        record = {"id": uid, "sent": False, "status": "failed", "started": time.time(),
                  "thread_id": client.headers.get("thread-id"), "session_id": client.headers.get("session-id"),
                  "role": client.headers.get("x-openai-subagent"), "raw_usage": None,
                  "returned_model": None, "provider_request_id": None}
        with self.lock:
            self.records.append(record)
        conn = None
        started_response = False
        try:
            require(not self.stopped.is_set(), "gateway closed")
            require(client.headers.get("Authorization") == "Bearer " + self.token, "gateway authentication rejected")
            segments = client.path.split("/")
            require(len(segments) == 3 and segments[2] == "responses" and segments[1] in self.routes, "unapproved endpoint")
            route = self.routes[segments[1]]
            record["route"] = segments[1]
            require(not client.headers.get("Content-Encoding"), "compressed request capture unsupported")
            size = int(client.headers.get("Content-Length", "0"))
            require(0 < size <= self.budget.limits["max_request_bytes"], "request body limit")
            client.connection.settimeout(5)
            body = json.loads(client.rfile.read(size))
            require(body["model"] in route["models"], "unapproved model")
            record["requested_model"] = body["model"]
            maximum = self.budget.limits["max_output_tokens"]
            body["max_output_tokens"] = min(int(body.get("max_output_tokens", maximum)), maximum)
            require(body["max_output_tokens"] > 0, "invalid output limit")
            record["request"] = body
            self.budget.admit(route["request_exposure_usd"])
            url = urlsplit(route["url"])
            cls = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
            conn = cls(url.hostname, url.port, timeout=min(5, max(0.1, self.budget.remaining_seconds())))
            with self.lock:
                self.connections.add(conn)
            headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
            if route.get("credential_env"):
                headers["Authorization"] = "Bearer " + os.environ[route["credential_env"]]
            for key in ("thread-id", "session-id", "x-openai-subagent"):
                if client.headers.get(key):
                    headers[key] = client.headers[key]
            record["sent"] = True
            conn.request("POST", url.path.rstrip("/") + "/responses", json.dumps(body).encode(), headers)
            response = conn.getresponse()
            record["http_status"] = response.status
            record["provider_request_id"] = response.getheader("x-request-id")
            record["content_type"] = response.getheader("Content-Type", "")
            client.send_response(response.status)
            client.send_header("Content-Type", record["content_type"])
            client.send_header("Connection", "close")
            client.end_headers()
            started_response = True
            raw, pending = bytearray(), b""
            record["events"] = []
            while not self.stopped.is_set() and self.budget.remaining_seconds() > 0:
                chunk = response.read1(65536)
                if not chunk:
                    break
                raw.extend(chunk)
                record["response_body"] = bytes(raw).decode("utf-8", errors="replace")
                require(len(raw) <= self.budget.limits["max_response_bytes"], "response body limit")
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if line.startswith(b"data: ") and line.strip() != b"data: [DONE]":
                        event = json.loads(line[6:])
                        record["events"].append(event)
                        if event.get("type") == "response.completed":
                            completion = event["response"]
                            record.update(raw_usage=completion.get("usage"), returned_model=completion.get("model"),
                                          response_id=completion.get("id"), status="completed")
                client.wfile.write(chunk)
                client.wfile.flush()
            record["response_body"] = bytes(raw).decode("utf-8", errors="replace")
            if "application/json" in record["content_type"] and response.status == 200:
                completion = json.loads(raw)
                record.update(raw_usage=completion.get("usage"), returned_model=completion.get("model"),
                              response_id=completion.get("id"), status="completed")
            if self.stopped.is_set() and record["status"] != "completed":
                record["status"] = "cancelled"
        except Exception as error:

            record["error"] = type(error).__name__ + ": " + str(error)
            for route in self.routes.values():
                secret = os.environ.get(route.get("credential_env", ""), "")
                if secret:
                    record["error"] = record["error"].replace(secret, "[redacted]")
            if not started_response:
                try:
                    client.send_error(502, "benchmark gateway rejected or failed request")
                except OSError:
                    pass
        finally:
            if conn:
                conn.close()
                with self.lock:
                    self.connections.discard(conn)
            record["finished"] = time.time()

    def ledger(self):
        entries = []
        for record in self.records:
            route = self.routes.get(record.get("route"), {})
            evidence = put(self.output, f"requests/{record['id']}.json", json.dumps(record))
            basis, amount = "unknown", None
            if not record["sent"]:
                basis, amount = "actual", "0"
            elif route.get("billing") == "subscription":
                basis = "subscription"
            elif route.get("billing") == "estimate" and record.get("raw_usage"):
                usage = record["raw_usage"]
                try:
                    amount = estimate_tokens({"input": usage["input_tokens"],
                        "cache_read": usage["input_tokens_details"]["cached_tokens"],
                        "cache_write": usage["input_tokens_details"]["cache_write_tokens"],
                        "output": usage["output_tokens"], "reasoning": usage["output_tokens_details"]["reasoning_tokens"]}, route["rates"])
                    basis = "estimate"
                except (KeyError, ValueError):
                    pass
            entry = {"id": record["id"], "billing_unit": record["id"], "scope": self.scope,
                     "category": "assessment" if self.scope == "evaluation" else "delegation" if record.get("role") else "implementation",
                     "actor": record.get("thread_id") or "unattributed", "attempt": len(entries) + 1,
                     "status": record["status"] if record.get("finished") else "in-flight", "basis": basis,
                     "usd": amount, "currency": "USD", "evidence": evidence,
                     "provider": record.get("route", "unattributed"), "account_alias": route.get("account_alias", "unattributed"),
                     "requested_model": record.get("requested_model", "unattributed"), "returned_model": record.get("returned_model"),
                     "request_id": record.get("provider_request_id"), "raw_usage": record.get("raw_usage")}
            if basis == "estimate":
                entry.update(rate_card=route["rate_card"], calculation={"rates": route["rates"], "raw_usage": record["raw_usage"]})
            entries.append(entry)
            charged_types = {"web_search", "web_search_preview", "code_interpreter", "image_generation", "file_search", "mcp"}
            if record["sent"] and any(t.get("type") in charged_types for t in record.get("request", {}).get("tools", [])):
                tool = dict(entry, id=entry["id"] + "-tools", billing_unit=entry["billing_unit"] + "-tools",
                            category="tool", basis="unknown", usd=None)
                tool.pop("rate_card", None)
                tool.pop("calculation", None)
                entries.append(tool)
        return entries
