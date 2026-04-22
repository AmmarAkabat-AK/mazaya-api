import { Router, type IRouter } from "express";
import { RedeemRewardBody } from "@workspace/api-zod";
import {
  db as pgDb,
  usersTable,
  vouchersTable,
  userLogsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { RouterOSClient } from "routeros-client";

const router: IRouter = Router();

// نوع المكافأة → البروفايل في اليوزر منجر وقيمة الكرت
const REWARD_PROFILES: Record<string, { profile: string; cardValue: number; cost: number; label: string }> = {
  "كرت ابو 100":  { profile: "100R.Y+4h",  cardValue: 100, cost: 50,  label: "100 ريال" },
  "كرت ابو 200":  { profile: "200R.Y+10h", cardValue: 200, cost: 100, label: "200 ريال" },
  "كرت VIP":      { profile: "300RY",       cardValue: 300, cost: 200, label: "300 ريال VIP" },
};

function getMikrotikClient() {
  const rawUrl = process.env.MIKROTIK_URL || "";
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    return new RouterOSClient({
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 8728,
      user: process.env.MIKROTIK_USER || "admin",
      password: process.env.MIKROTIK_PASS || "",
      timeout: 20,
    });
  } catch { return null; }
}

function withT<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms`)), ms))]);
}

function randomCode(): string {
  return String(Math.floor(10000000 + Math.random() * 89999999));
}

// إنشاء مستخدم في اليوزر منجر (RouterOS 6 — بدون تعيين بروفايل عبر API)
async function createUserInMikrotik(): Promise<string | null> {
  const client = getMikrotikClient();
  if (!client) return null;
  (client as any).on?.("error", () => {});

  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => { try { client.close(); } catch {} resolve(null); }, 12000);
    (async () => {
      try {
        const conn = await withT(client.connect(), 10000);
        const rosApi = (conn as any).rosApi;
        if (!rosApi?.write) throw new Error("no rosApi");

        for (let i = 0; i < 5; i++) {
          const username = randomCode();
          try {
            const res = await withT(
              rosApi.write(["/tool/user-manager/user/add", `=username=${username}`, "=customer=admin"]),
              5000
            );
            if (res?.[0]?.ret) {
              clearTimeout(timer);
              try { await client.close(); } catch {}
              console.info(`[Rewards] Created MikroTik user: ${username}`);
              return resolve(username);
            }
          } catch (addErr: any) {
            if (addErr?.message?.includes("already") || addErr?.message?.includes("exists")) continue;
            throw addErr;
          }
        }
        clearTimeout(timer);
        try { await client.close(); } catch {}
        resolve(null);
      } catch (err: any) {
        clearTimeout(timer);
        try { await client.close(); } catch {}
        console.warn("[Rewards] MikroTik create failed:", err?.message);
        resolve(null);
      }
    })();
  });
}

router.post("/redeemReward", async (req, res): Promise<void> => {
  const parsed = RedeemRewardBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "❌ بيانات ناقصة" }); return; }

  const { userCode, rewardName } = parsed.data;

  const rewardInfo = REWARD_PROFILES[rewardName];
  if (!rewardInfo) { res.status(400).json({ error: "❌ قيمة المكافأة غير صالحة" }); return; }

  const users = await pgDb.select().from(usersTable).where(eq(usersTable.code, userCode)).limit(1);
  if (users.length === 0) { res.status(400).json({ error: "❌ المستخدم غير موجود" }); return; }
  const user = users[0];

  if ((user.points || 0) < rewardInfo.cost) {
    res.status(400).json({ error: `تحتاج ${rewardInfo.cost} نقطة — رصيدك: ${user.points}` });
    return;
  }

  // 1) حاول سحب كرت من مخزون vouchers ببروفايل محدد
  let cardNumber: string | null = null;
  let voucherId: number | null = null;
  let fromPool = false;

  const poolCards = await pgDb.select().from(vouchersTable)
    .where(and(eq(vouchersTable.used, false), eq(vouchersTable.profile, rewardInfo.profile)))
    .limit(1);

  if (poolCards.length > 0) {
    cardNumber = poolCards[0].cardNumber;
    voucherId = poolCards[0].id;
    fromPool = true;
    console.info(`[Rewards] ${rewardName} from pool: ${cardNumber} (profile: ${rewardInfo.profile})`);
  }

  // 2) إذا لم يوجد مخزون → أنشئ مستخدماً في اليوزر منجر مباشرة
  if (!cardNumber) {
    console.info(`[Rewards] Pool empty for ${rewardInfo.profile}, trying MikroTik live...`);
    cardNumber = await createUserInMikrotik();
    if (cardNumber) {
      await pgDb.insert(vouchersTable).values({
        cardNumber,
        value: rewardInfo.cardValue,
        profile: rewardInfo.profile,
        source: "reward-live",
      }).onConflictDoNothing();
      console.info(`[Rewards] MikroTik live card: ${cardNumber}`);
    }
  }

  if (!cardNumber) {
    res.status(400).json({ error: `لا توجد كروت ${rewardInfo.profile} متاحة — اطلب من المدير إضافة كروت` });
    return;
  }

  // 3) سجّل الكرت كمستخدم
  if (voucherId) {
    await pgDb.update(vouchersTable)
      .set({ used: true, usedBy: userCode, usedAt: new Date() })
      .where(eq(vouchersTable.id, voucherId));
  } else {
    await pgDb.update(vouchersTable)
      .set({ used: true, usedBy: userCode, usedAt: new Date() })
      .where(eq(vouchersTable.cardNumber, cardNumber));
  }

  // 4) خصم النقاط
  const newPoints = (user.points || 0) - rewardInfo.cost;
  await pgDb.update(usersTable)
    .set({ points: newPoints })
    .where(eq(usersTable.code, userCode));

  await pgDb.insert(userLogsTable).values({
    userCode,
    message: `تم استبدال ${rewardInfo.cost} نقطة بـ ${rewardName} (${rewardInfo.profile})${fromPool ? "" : " [من اليوزر منجر مباشرة]"}`,
  });

  res.json({
    username: cardNumber,
    rewardName,
    profile: rewardInfo.profile,
    cardValue: rewardInfo.cardValue,
    newPoints,
  });
});

export default router;
