import contextlib
import contextvars
import io
import json
import os
import socket
import sys
import tempfile


class LimitedOutput(io.StringIO):
    def __init__(self):
        super().__init__()
        self.bytes = 0

    def write(self, value):
        size = len(value.encode("utf-8"))
        if self.bytes + size > 65536:
            raise ValueError("kernel output limit exceeded")
        self.bytes += size
        return super().write(value)


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
captured = tempfile.TemporaryFile()
for line in sys.stdin:
    output = LimitedOutput()
    bridge_failed = False
    saved = None
    try:
        request = json.loads(line)
        if request.get("shutdown") is True:
            break
        active = {"active": True}
        context_token = bridge_context.set((request["port"], request["token"], active))
        captured.seek(0)
        captured.truncate()
        saved = (os.dup(1), os.dup(2))
        os.dup2(captured.fileno(), 1)
        os.dup2(captured.fileno(), 2)
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(compile(request["code"], "<omd-python-cell>", "exec"), state)
        response = {"ok": True}
    except Exception as error:
        response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    finally:
        if saved:
            for target, descriptor in enumerate(saved, 1):
                os.dup2(descriptor, target)
                os.close(descriptor)
        if "active" in locals():
            active["active"] = False
            bridge_context.reset(context_token)
            del active
    captured.seek(0)
    extra = captured.read(65536 - output.bytes + 1)
    if len(extra) > 65536 - output.bytes:
        extra = extra[: 65536 - output.bytes]
        response = {"ok": False, "error": "ValueError: kernel output limit exceeded"}
    response["output"] = output.getvalue() + extra.decode("utf-8", "replace")
    response["bridge_failed"] = bridge_failed
    protocol.write("CODE_KERNEL_RESULT:" + json.dumps(response, separators=(",", ":")) + "\n")
    protocol.flush()
