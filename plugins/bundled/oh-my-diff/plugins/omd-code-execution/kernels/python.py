import contextlib
import contextvars
import io
import json
import os
import socket
import sys
import threading


class LimitedOutput(io.TextIOBase):
    def __init__(self):
        super().__init__()
        self.bytes = 0

    def write(self, value):
        data = memoryview(value.encode("utf-8"))
        if self.bytes + len(data) > 65536:
            raise ValueError("kernel output limit exceeded")
        self.bytes += len(data)
        while data:
            data = data[os.write(1, data):]
        return len(value)


bridge_context = contextvars.ContextVar("omd_bridge", default=None)
bridge_failed = False
state = {"__name__": "__omd_cell__"}


def tool(name, arguments=None):
    global bridge_failed
    bridge = bridge_context.get()
    if bridge is None or not bridge[2]["active"]:
        raise RuntimeError("no active kernel cell")
    request = {"token": bridge[1], "name": name, "arguments": arguments or {}}
    payload = json.dumps(request, separators=(",", ":")).encode() + b"\n"
    if len(payload) > 65536:
        raise ValueError("tool request limit exceeded")
    try:
        with socket.create_connection(("127.0.0.1", bridge[0]), timeout=5) as connection:
            connection.settimeout(120)
            connection.sendall(payload)
            result = bytearray()
            while not result.endswith(b"\n"):
                chunk = connection.recv(8192)
                if not chunk:
                    raise ConnectionError("tool bridge disconnected")
                result.extend(chunk)
                if len(result) > 262144:
                    raise ValueError("tool response limit exceeded")
        response = json.loads(result)
    except (socket.timeout, TimeoutError) as error:
        raise RuntimeError("tool bridge timeout") from error
    except OSError as error:
        bridge_failed = True
        raise RuntimeError(f"tool bridge disconnected: {error}") from error
    except ValueError as error:
        raise RuntimeError(f"invalid tool bridge response: {error}") from error
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "tool call failed"))
    return response["result"]


state["tool"] = tool
protocol = os.fdopen(os.dup(1), "w")
reader, writer = os.pipe()
os.dup2(writer, 1)
os.dup2(writer, 2)
marker = os.urandom(16).hex().encode()
captured = {"data": bytearray(), "held": b"", "overflow": False, "ended": False}
condition = threading.Condition()


def keep(data):
    room = 65536 - len(captured["data"])
    if len(data) > room:
        captured["overflow"] = True
    captured["data"] += data[:room]


def drain():
    while chunk := os.read(reader, 65536):
        with condition:
            held = captured["held"] + chunk
            while (end := held.find(marker)) >= 0:
                keep(held[:end])
                held = held[end + len(marker):]
                captured["ended"] = True
                condition.notify_all()
            cut = max(len(held) - len(marker) + 1, 0)
            keep(held[:cut])
            captured["held"] = held[cut:]


threading.Thread(target=drain, daemon=True).start()
for line in sys.stdin:
    output = LimitedOutput()
    bridge_failed = False
    with condition:
        captured.update(data=bytearray(), held=b"", overflow=False, ended=False)
    try:
        request = json.loads(line)
        if request.get("shutdown") is True:
            break
        active = {"active": True}
        context_token = bridge_context.set((request["port"], request["token"], active))
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(compile(request["code"], "<omd-python-cell>", "exec"), state)
        response = {"ok": True}
    except Exception as error:
        response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    finally:
        if "active" in locals():
            active["active"] = False
            bridge_context.reset(context_token)
            del active
    os.write(writer, marker)
    with condition:
        condition.wait_for(lambda: captured["ended"], 5)
        extra = bytes(captured["data"])
        overflow = captured["overflow"]
    notice = "ValueError: kernel output limit exceeded"
    if overflow and notice not in response.get("error", ""):
        response["error"] = f"{response['error']}\n{notice}" if "error" in response else notice
        response["ok"] = False
    response["output"] = extra.decode("utf-8", "replace")
    response["bridge_failed"] = bridge_failed
    protocol.write("CODE_KERNEL_RESULT:" + json.dumps(response, separators=(",", ":")) + "\n")
    protocol.flush()
