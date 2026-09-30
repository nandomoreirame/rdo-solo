//! The privileged bridge to the gateway: flip the filter and read status by
//! running the rdo-solo binary (optionally under sudo). Command output parsing
//! lives in status.ts so it stays pure and unit-tested; this file only spawns.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config";
import { parseStatusJson, type SoloStatus } from "./status";

const pexec = promisify(execFile);

/** Build the argv, prefixing `sudo -n` (non-interactive) when configured. */
function resolve(args: string[]): { file: string; argv: string[] } {
  const cfg = getConfig();
  return cfg.sudo ? { file: "sudo", argv: ["-n", cfg.bin, ...args] } : { file: cfg.bin, argv: args };
}

export async function toggleSolo(on: boolean): Promise<void> {
  const { file, argv } = resolve([on ? "on" : "off"]);
  await pexec(file, argv, { timeout: 15_000 });
}

export async function readStatus(): Promise<SoloStatus> {
  const { file, argv } = resolve(["status", "--json"]);
  const { stdout } = await pexec(file, argv, { timeout: 15_000 });
  return parseStatusJson(stdout);
}
