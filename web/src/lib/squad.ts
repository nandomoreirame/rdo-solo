export function isValidIp(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

export interface SquadList {
  capturedAt: string | null;
  ips: string[];
}

export function parseSquadList(body: string): SquadList {
  let capturedAt: string | null = null;
  const ips: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      const m = /captured_at=(.+)$/.exec(t);
      if (m) capturedAt = m[1].trim();
      continue;
    }
    if (isValidIp(t) && !ips.includes(t)) ips.push(t);
  }
  return { capturedAt, ips };
}

export function formatSquadList(ips: string[], capturedAt: string): string {
  const clean = ips.filter((ip, i) => isValidIp(ip) && ips.indexOf(ip) === i);
  return `# captured_at=${capturedAt}\n${clean.join("\n")}\n`;
}
