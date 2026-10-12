"""Drain a measured PTY independently of the terminal parser."""

import errno
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys
import time


HEADER = struct.Struct("!cQI")
QUEUE_LIMIT = 8 * 1024 * 1024


def frame(kind, data=b"", received=0):
    return HEADER.pack(kind, received, len(data)) + data


def drain(master, channel):
    channel.setblocking(False)
    pending = bytearray(frame(b"R"))
    opened = True
    while opened or pending:
        readable, writable, _ = select.select(
            [channel, master] if opened else [channel], [channel] if pending else [], [], 5
        )
        if channel in readable:
            return  # Parent closed or sent an invalid request.
        if master in readable:
            try:
                data = os.read(master, 65536)
                received = time.perf_counter_ns()
            except OSError as error:
                if error.errno != errno.EIO:
                    pending.extend(frame(b"E", str(error).encode()))
                data = b""
            if data:
                pending.extend(frame(b"D", data, received))
                if len(pending) > QUEUE_LIMIT:
                    raise RuntimeError("terminal capture queue limit exceeded")
            else:
                pending.extend(frame(b"F"))
                opened = False
        if channel in writable:
            try:
                sent = channel.send(pending)
                del pending[:sent]
            except BlockingIOError:
                pass
            except (BrokenPipeError, ConnectionResetError):
                return


class Capture:
    def __init__(self, master):
        self.channel, child = socket.socketpair()
        self.buffer = bytearray()
        try:
            self.process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), str(master), str(child.fileno())],
                pass_fds=(master, child.fileno()), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
        except BaseException:
            self.channel.close()
            child.close()
            raise
        child.close()
        self.channel.setblocking(False)
        try:
            if self.read(5) != (b"R", 0, b""):
                raise RuntimeError("terminal capture did not become ready")
        except BaseException:
            self.close()
            raise

    def available(self):
        return len(self.buffer) >= HEADER.size and len(self.buffer) >= HEADER.size + HEADER.unpack_from(self.buffer)[2]

    def read(self, timeout=0):
        deadline = time.perf_counter() + timeout
        while not self.available():
            if not select.select([self.channel], [], [], max(0, deadline - time.perf_counter()))[0]:
                return None
            data = self.channel.recv(65536)
            if not data:
                raise RuntimeError("terminal capture exited before output completed")
            self.buffer.extend(data)
            if len(self.buffer) >= HEADER.size and HEADER.unpack_from(self.buffer)[2] > 65536:
                raise RuntimeError("invalid terminal capture frame")
        kind, received, size = HEADER.unpack_from(self.buffer)
        data = bytes(self.buffer[HEADER.size:HEADER.size + size])
        del self.buffer[:HEADER.size + size]
        if kind == b"E":
            raise RuntimeError(data.decode(errors="replace"))
        if kind == b"F":
            raise RuntimeError("terminal output closed before observation completed")
        return kind, received, data

    def close(self):
        self.channel.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        error = (f"terminal capture exited with status {self.process.returncode}: "
                 + self.process.stderr.read().decode(errors="replace")) if self.process.returncode else None
        self.process.stderr.close()
        return error


if __name__ == "__main__":
    drain(int(sys.argv[1]), socket.socket(fileno=int(sys.argv[2])))
