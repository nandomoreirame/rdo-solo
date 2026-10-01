//! The privileged bridge to the gateway: flip the filter and read status by
//! running the rdo-solo binary (optionally under sudo). Command output parsing
//! lives in status.ts so it stays pure and unit-tested; this file only spawns.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config";
import { isValidIp } from "./squad";
import { parseStatusJson, type SoloStatus } from "./status";

const pexec = promisify(execFile);

/** Build the argv, prefixing `sudo -n` (non-interactive) when configured. */
function resolve(args: string[]): { file: string; argv: string[] } {
  const cfg = getConfig();
  return cfg.sudo ? { file: "sudo", argv: ["-n", cfg.bin, ...args] } : { file: cfg.bin, argv: args };
}

/** Validate IPs then build `squad-set` argv. Throws if empty or any IP is invalid. */
export function buildSquadSetArgs(ips: string[]): string[] {
  if (ips.length === 0) {
    throw new Error("squad-set requires at least one IP");
  }
  for (const ip of ips) {
    if (!isValidIp(ip)) {
      throw new Error(`invalid IP: ${ip}`);
    }
  }
  return ["squad-set", ...ips];
}

export async function toggleSolo(on: boolean): Promise<void> {
  await setMode(on ? "solo" : "off");
}

export async function setMode(mode: "off" | "solo" | "squad"): Promise<void> {
  const cmd = mode === "off" ? "off" : mode === "solo" ? "on" : "squad-on";
  const { file, argv } = resolve([cmd]);
  await pexec(file, argv, { timeout: 15_000 });
}

export async function captureSquad(ips: string[]): Promise<void> {
  const { file, argv } = resolve(buildSquadSetArgs(ips));
  await pexec(file, argv, { timeout: 15_000 });
}

export async function readSquad(): Promise<string[]> {
  const { file, argv } = resolve(["squad-list"]);
  const { stdout } = await pexec(file, argv, { timeout: 15_000 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isValidIp(line));
}

export async function clearSquad(): Promise<void> {
  const { file, argv } = resolve(["squad-clear"]);
  await pexec(file, argv, { timeout: 15_000 });
}

export async function readStatus(): Promise<SoloStatus> {
  const { file, argv } = resolve(["status", "--json"]);
  const { stdout } = await pexec(file, argv, { timeout: 15_000 });
  return parseStatusJson(stdout);
}
