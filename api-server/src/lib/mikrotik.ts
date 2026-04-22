/**
 * src/lib/mikrotik.ts
 * يعتمد على User Manager Sessions
 * يرجع:
 * found / over_limit / disabled / not_found / error
 */

import { RouterOSClient } from "routeros-client";

export function isMikrotikEnabled(): boolean {
  return !!process.env.MIKROTIK_URL;
}

function getConfig() {
  const rawUrl = process.env.MIKROTIK_URL || "";
  const user = process.env.MIKROTIK_USER || "admin";
  const pass = process.env.MIKROTIK_PASS || "";

  if (!rawUrl) return null;

  try {
    const u = new URL(rawUrl);

    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 8728,
      user,
      pass,
    };
  } catch {
    return {
      host: rawUrl,
      port: 8728,
      user,
      pass,
    };
  }
}

function makeClient(cfg: any) {
  return new RouterOSClient({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.pass,
    timeout: 20,
  });
}

function toNumber(v: any): number {
  return Number(v || 0);
}

function bytesToMB(v: number): number {
  return v / 1024 / 1024;
}

export async function mikrotikFindVoucher(cardNumber: string): Promise<any> {
  if (!isMikrotikEnabled()) return { status: "error" };

  const cfg = getConfig();
  if (!cfg) return { status: "error" };

  const client = makeClient(cfg);

  try {
    const conn = await client.connect();

    let users: any[] = [];

    try {
      users = await conn
        .menu("/tool/user-manager/user")
        .where({ username: cardNumber })
        .get();
    } catch {}

    if (!users.length) {
      try {
        users = await conn
          .menu("/tool/user-manager/user")
          .where({ name: cardNumber })
          .get();
      } catch {}
    }

    if (!users.length) {
      try {
        users = await conn
          .menu("/ip/hotspot/user")
          .where({ name: cardNumber })
          .get();
      } catch {}
    }

    if (!users.length) {
      try {
        await client.close();
      } catch {}

      return { status: "not_found" };
    }

    const voucher = users[0];

    if (
      voucher.disabled === true ||
      voucher.disabled === "true" ||
      voucher.disabled === "yes"
    ) {
      try {
        await client.close();
      } catch {}

      return { status: "disabled" };
    }

    let sessions: any[] = [];

    try {
      sessions = await conn
        .menu("/tool/user-manager/session")
        .where({ user: cardNumber })
        .get();
    } catch {}

    let totalDownload = 0;
    let totalUpload = 0;

    for (const row of sessions) {
      totalDownload += toNumber(row.download);
      totalUpload += toNumber(row.upload);
    }

    const totalBytes = totalDownload + totalUpload;
    const totalMB = bytesToMB(totalBytes);

    try {
      await client.close();
    } catch {}

    // الحد الحقيقي حسب قيمة الكرت
    const limitMB = getValueFromVoucher(voucher, cardNumber);

    if (totalMB >= limitMB) {
      return {
        status: "over_limit",
        voucher,
        usedMB: Math.round(totalMB),
        limitMB,
        downloadMB: Math.round(bytesToMB(totalDownload)),
        uploadMB: Math.round(bytesToMB(totalUpload)),
      };
    }

    return {
      status: "found",
      voucher,
      usedMB: Math.round(totalMB),
      limitMB,
      downloadMB: Math.round(bytesToMB(totalDownload)),
      uploadMB: Math.round(bytesToMB(totalUpload)),
    };
  } catch {
    try {
      await client.close();
    } catch {}

    return { status: "error" };
  }
}

export async function mikrotikDisableVoucher(id: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg) return;

  const client = makeClient(cfg);

  try {
    const conn = await client.connect();

    try {
      await conn
        .menu("/tool/user-manager/user")
        .where({ ".id": id })
        .update({ disabled: "true" });
    } catch {}

    try {
      await conn
        .menu("/ip/hotspot/user")
        .where({ ".id": id })
        .update({ disabled: "yes" });
    } catch {}

    try {
      await client.close();
    } catch {}
  } catch {}
}

export function getValueFromVoucher(voucher: any, fallback: string): number {
  const txt = String(
    voucher?.actualProfile || voucher?.profile || voucher?.group || fallback,
  );

  const m = txt.match(/\d+/);

  if (m) return parseInt(m[0], 10);

  return 100;
}
