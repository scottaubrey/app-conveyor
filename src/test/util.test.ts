import { expect, spyOn, test } from "bun:test";
import { Logger } from "../util";

test("Logger adds timestamp when not in test mode", () => {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});

  // Temporarily change NODE_ENV
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  try {
    Logger.log("test message");

    expect(logSpy.mock.calls.length).toBe(1);
    const call = logSpy.mock.calls[0];
    expect(String(call?.[0])).toMatch(
      /^timestamp="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z"$/,
    );
    expect(call?.[1]).toBe("test message");
  } finally {
    // Restore NODE_ENV
    process.env.NODE_ENV = oldEnv;
    logSpy.mockRestore();
  }
});

test("Logger is silent in test mode", () => {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});

  // NODE_ENV is "test" during bun test
  Logger.log("should not appear");

  expect(logSpy.mock.calls.length).toBe(0);

  logSpy.mockRestore();
});
