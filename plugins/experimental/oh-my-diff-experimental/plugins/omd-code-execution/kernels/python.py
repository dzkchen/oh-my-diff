import concurrent.futures
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
            data = data[write(1, data):]
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
devnull = os.open(os.devnull, os.O_WRONLY)
os.dup2(devnull, 1)
os.dup2(devnull, 2)
marker = os.urandom(16).hex().encode()
condition = threading.Condition()
cell = {"id": 0, "output": None}
start_thread = threading.Thread.start


def owner():
    thread = threading.current_thread()
    return cell["id"] if thread is threading.main_thread() else getattr(thread, "_omd_cell", cell["id"])


def start(self):
    self._omd_cell = owner()
    start_thread(self)


def submit(self, function, /, *args, **kwargs):
    caller = owner()

    def run():
        thread = threading.current_thread()
        previous = thread._omd_cell
        thread._omd_cell = caller
        try:
            return function(*args, **kwargs)
        finally:
            thread._omd_cell = previous

    return submit_work(self, run)


threading.Thread.start = start
submit_work = concurrent.futures.ThreadPoolExecutor.submit
concurrent.futures.ThreadPoolExecutor.submit = submit
write = os.write


def guarded(fd, data):
    if fd in (1, 2) and (cell["output"] is None or owner() != cell["id"]):
        return len(data)
    return write(fd, data)


os.write = guarded


class CellOutput(io.TextIOBase):
    def write(self, value):
        output = cell["output"]
        if output is None or owner() != cell["id"]:
            return len(value)
        return output.write(value)


router = CellOutput()
sys.__stdout__ = sys.__stderr__ = router


def keep(captured, data):
    room = 65536 - len(captured["data"])
    if len(data) > room:
        captured["overflow"] = True
    captured["data"] += data[:room]


def drain(reader, captured):
    held = b""
    while chunk := os.read(reader, 65536):
        with condition:
            if captured["ended"]:
                continue
            held += chunk
            if (end := held.find(marker)) >= 0:
                keep(captured, held[:end])
                captured["ended"] = True
                condition.notify_all()
                continue
            cut = max(len(held) - len(marker) + 1, 0)
            keep(captured, held[:cut])
            held = held[cut:]
    os.close(reader)


commands = os.fdopen(os.dup(0), encoding="utf-8")  # exit() closes sys.stdin
for line in commands:
    output = LimitedOutput()
    bridge_failed = False
    token = ""
    captured = {"data": bytearray(), "overflow": False, "ended": False}
    reader, writer = os.pipe()
    os.dup2(writer, 1)
    os.dup2(writer, 2)
    threading.Thread(target=drain, args=(reader, captured), daemon=True).start()
    cell["id"] += 1
    cell["output"] = output
    sys.stdout = sys.stderr = router
    try:
        request = json.loads(line)
        if request.get("shutdown") is True:
            break
        token = str(request.get("token", ""))
        active = {"active": True}
        context_token = bridge_context.set((request["port"], request["token"], active))
        exec(compile(request["code"], "<omd-python-cell>", "exec"), state)
        response = {"ok": True}
    except BaseException as error:
        response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    finally:
        if "active" in locals():
            active["active"] = False
            bridge_context.reset(context_token)
            del active
    cell["output"] = None
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    write(writer, marker)
    os.close(writer)
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
    protocol.write(f"CODE_KERNEL_RESULT:{token}:" + json.dumps(response, separators=(",", ":")) + "\n")
    protocol.flush()
