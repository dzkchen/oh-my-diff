import fs from "node:fs";
import {BridgeClient} from "./client.mjs";

export function fromConnectionFile(connectionFile, application) {
  const connection = JSON.parse(fs.readFileSync(connectionFile, "utf8"));
  return new BridgeClient(connection, application);
}

export function captureProcessErrors(client, processObject = process) {
  const exception = error => client.event("exception", String(error?.message || error), {stack: error?.stack}, "error").catch(() => {});
  const rejection = reason => client.event("exception", String(reason?.message || reason), {stack: reason?.stack}, "error").catch(() => {});
  processObject.on("uncaughtExceptionMonitor", exception);
  processObject.on("unhandledRejection", rejection);
  return () => {
    processObject.off("uncaughtExceptionMonitor", exception);
    processObject.off("unhandledRejection", rejection);
  };
}
