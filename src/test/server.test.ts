import { expect, spyOn, test } from "bun:test";
import type { Server } from "bun";
import * as db from "../db";
import { createServer } from "../server";
import type { PipelineConfig } from "../types";
import { Logger } from "../util";

// Mock DB
spyOn(db, "listPackages").mockReturnValue([]);
spyOn(db, "findPackageByCommitPrefix").mockReturnValue(null);
spyOn(db, "getStepHistory").mockReturnValue([]);
spyOn(db, "resetPackage").mockReturnValue();

type Handler = (
  req: Request & { params: Record<string, string> },
) => Promise<Response>;
type CapturedRoutes = Record<string, Handler>;

test("server audit logs: sync-pipeline anonymous", async () => {
  let capturedRoutes: CapturedRoutes = {};
  const serveSpy = spyOn(Bun, "serve").mockImplementation((options) => {
    capturedRoutes = options.routes as unknown as CapturedRoutes;
    return {} as Server<any>;
  });

  const logSpy = spyOn(Logger, "log");
  const pipelines = new Map<string, PipelineConfig>([
    ["test-pl", { id: "test-pl", name: "Test Pipeline", steps: [] }],
  ]);
  const pollers = new Map<string, () => Promise<void>>([
    ["test-pl", async () => {}],
  ]);

  createServer(pipelines, pollers, new Map());

  const handler = capturedRoutes["/pipeline/:pipelineId/sync"];
  if (!handler) throw new Error("Handler not found");

  const req = new Request("http://localhost:3000/pipeline/test-pl/sync", {
    method: "POST",
  }) as Request & { params: Record<string, string> };

  // Simulate Bun's router by adding params to req
  req.params = { pipelineId: "test-pl" };

  await handler(req);

  const auditLogs = logSpy.mock.calls.filter((call) =>
    call.some((arg) => String(arg).includes("[AUDIT]")),
  );
  expect(auditLogs.length).toBe(1);
  // The spy sees the arguments passed to Logger.log, which is the raw message.
  // The timestamp is added inside Logger.log before calling console.log.
  expect(String(auditLogs[0]?.[0])).toContain("[AUDIT]");
  expect(String(auditLogs[0]?.[0])).toContain('user="anonymous"');
  expect(String(auditLogs[0]?.[0])).toContain('action="sync-pipeline"');
  expect(String(auditLogs[0]?.[0])).toContain('pipeline="test-pl"');

  logSpy.mockRestore();
  serveSpy.mockRestore();
});

test("server audit logs: sync-pipeline with user", async () => {
  let capturedRoutes: CapturedRoutes = {};
  const serveSpy = spyOn(Bun, "serve").mockImplementation((options) => {
    capturedRoutes = options.routes as unknown as CapturedRoutes;
    return {} as Server<any>;
  });

  const logSpy = spyOn(Logger, "log");
  const pipelines = new Map<string, PipelineConfig>([
    ["test-pl", { id: "test-pl", name: "Test Pipeline", steps: [] }],
  ]);
  const pollers = new Map<string, () => Promise<void>>([
    ["test-pl", async () => {}],
  ]);

  createServer(pipelines, pollers, new Map());

  const handler = capturedRoutes["/pipeline/:pipelineId/sync"];
  if (!handler) throw new Error("Handler not found");

  const req = new Request("http://localhost:3000/pipeline/test-pl/sync", {
    method: "POST",
    headers: {
      "X-Auth-Request-User": "jdoe",
    },
  }) as Request & { params: Record<string, string> };
  req.params = { pipelineId: "test-pl" };

  await handler(req);

  const auditLogs = logSpy.mock.calls.filter((call) =>
    call.some((arg) => String(arg).includes("[AUDIT]")),
  );
  expect(auditLogs.length).toBe(1);
  expect(String(auditLogs[0]?.[0])).toContain("[AUDIT]");
  expect(String(auditLogs[0]?.[0])).toContain('user="jdoe"');
  expect(String(auditLogs[0]?.[0])).toContain('action="sync-pipeline"');

  logSpy.mockRestore();
  serveSpy.mockRestore();
});
