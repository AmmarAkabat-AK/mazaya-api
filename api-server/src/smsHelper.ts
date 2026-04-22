import { RouterOSClient } from "routeros-client";

function withT<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms`)), ms))]);
}

export async function sendSmsViaRouter(message: string): Promise<{ ok: boolean; error?: string }> {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) return { ok: false, error: "ADMIN_PHONE not set" };

  const rawUrl = process.env.MIKROTIK_URL || "";
  if (!rawUrl) return { ok: false, error: "MIKROTIK_URL not set" };

  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, error: "Invalid MIKROTIK_URL" }; }

  const client = new RouterOSClient({
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 8728,
    user: process.env.MIKROTIK_USER || "admin",
    password: process.env.MIKROTIK_PASS || "",
    timeout: 30,
  });

  try {
    (client as any).on?.("error", () => {});
    const conn = await withT(client.connect(), 8000);
    const rosApi = (conn as any).rosApi;

    await withT(
      rosApi.write(["/tool/sms/send", `=numbers=${adminPhone}`, `=message=${message}`, "=channel=0"]),
      10000
    );
    console.info(`[SMS] ✅ Sent to ${adminPhone}: ${message.slice(0, 40)}...`);
    try { await client.close(); } catch {}
    return { ok: true };
  } catch (e: any) {
    console.warn(`[SMS] ❌ Failed: ${e?.message}`);
    try { await client.close(); } catch {}
    return { ok: false, error: e?.message };
  }
}
