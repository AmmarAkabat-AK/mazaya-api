import { RouterOSClient } from "routeros-client";
import { db, vouchersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

(async () => {
  const u = new URL(process.env.MIKROTIK_URL || "");

  const api = new RouterOSClient({
    host: u.hostname,
    port: Number(u.port || 8728),
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASS,
  });

  const conn = await api.connect();
  const rows = await conn.menu("/tool/user-manager/user").get();

  let updated = 0;

  for (const r of rows as any[]) {
    const card = String(r.username || "").trim();
    if (!card) continue;

    const down = Number(r.downloadUsed || 0);
    const up = Number(r.uploadUsed || 0);
    const total = (down + up) / 1024 / 1024;

    const txt = String(r.actualProfile || "");
    const m = txt.match(/\d+/);
    const limit = m ? parseInt(m[0], 10) : 100;

    const disabled = r.disabled === true || r.disabled === "yes";

    if (disabled || total >= limit) {
      await db
        .update(vouchersTable)
        .set({ used: true })
        .where(eq(vouchersTable.cardNumber, card));

      updated++;
    }
  }

  console.log("Updated:", updated);

  await api.close();
})();
