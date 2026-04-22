import { Router, type IRouter } from "express";
import {
  db as pgDb,
  usersTable,
  rewardCardsTable,
  userLogsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

// ─── جوائز العجلة ─────────────────────────────────────────────────────────────
// حظ أوفر × 4  |  3 نقاط  |  5 نقاط  |  10 نقاط  |  كرت مجاني  |  كرت سلفة
const PRIZES = [
  { id: "luck",    label: "حظ أوفر",    type: "luck",   color: "#555",    weight: 4 },
  { id: "pts3",    label: "3 نقاط",      type: "points", value: 3,         color: "#27ae60", weight: 1 },
  { id: "pts5",    label: "5 نقاط",      type: "points", value: 5,         color: "#27ae60", weight: 1 },
  { id: "pts10",   label: "10 نقاط",     type: "points", value: 10,        color: "#2ecc71", weight: 1 },
  { id: "free",    label: "كرت مجاني",   type: "free",   color: "#c9a847", weight: 1 },
  { id: "loan",    label: "كرت سلفة",    type: "loan",   color: "#e74c3c", weight: 1 },
];

// توليد مصفوفة مرجحة
const WEIGHTED_PRIZES: typeof PRIZES = [];
for (const p of PRIZES) {
  for (let i = 0; i < p.weight; i++) WEIGHTED_PRIZES.push(p);
}

function pickPrize() {
  return WEIGHTED_PRIZES[Math.floor(Math.random() * WEIGHTED_PRIZES.length)];
}

// ─── GET /wheel/prizes — قائمة الجوائز للعرض ────────────────────────────────
router.get("/wheel/prizes", (_req, res) => {
  res.json({ prizes: PRIZES });
});

// ─── POST /spinWheel ──────────────────────────────────────────────────────────
router.post("/spinWheel", async (req, res): Promise<void> => {
  const { userCode } = req.body as { userCode?: string };
  if (!userCode) { res.status(400).json({ error: "❌ معرّف المستخدم مطلوب" }); return; }

  const users = await pgDb.select().from(usersTable).where(eq(usersTable.code, userCode)).limit(1);
  if (users.length === 0) { res.status(400).json({ error: "❌ المستخدم غير موجود" }); return; }
  const user = users[0];

  const MIN_POINTS_TO_SPIN = 30;
  if ((user.points || 0) < MIN_POINTS_TO_SPIN) {
    res.status(400).json({ error: `❌ تحتاج ${MIN_POINTS_TO_SPIN} نقطة على الأقل لتدوير العجلة — رصيدك الحالي: ${user.points || 0} نقطة` });
    return;
  }

  const prize = pickPrize();
  let cardNumber: string | null = null;
  let extraMsg = "";

  if (prize.type === "points") {
    // إضافة نقاط
    const newPoints = (user.points || 0) + (prize.value || 0);
    await pgDb.update(usersTable).set({ points: newPoints }).where(eq(usersTable.code, userCode));
    await pgDb.insert(userLogsTable).values({
      userCode,
      message: `🎡 عجلة الحظ: ربحت ${prize.value} نقطة`,
    });
    return res.json({ prize: prize.id, label: prize.label, points: prize.value, newPoints });
  }

  if (prize.type === "free") {
    // كرت مجاني من مخزون Selefny
    const pool = await pgDb.select().from(rewardCardsTable)
      .where(and(eq(rewardCardsTable.rewardType, "Selefny"), eq(rewardCardsTable.used, false)))
      .limit(1);

    if (pool.length > 0) {
      cardNumber = pool[0].username;
      await pgDb.update(rewardCardsTable)
        .set({ used: true, usedBy: userCode })
        .where(eq(rewardCardsTable.id, pool[0].id));
      await pgDb.insert(userLogsTable).values({
        userCode,
        message: `🎡 عجلة الحظ: كرت مجاني ${cardNumber}`,
      });
      return res.json({ prize: prize.id, label: prize.label, cardNumber, cardType: "Selefny" });
    } else {
      // المخزون فارغ → يُحوَّل لنقاط 5
      extraMsg = " (المخزون فارغ — عوضاً: 5 نقاط)";
      const newPoints = (user.points || 0) + 5;
      await pgDb.update(usersTable).set({ points: newPoints }).where(eq(usersTable.code, userCode));
      await pgDb.insert(userLogsTable).values({
        userCode,
        message: `🎡 عجلة الحظ: كرت مجاني (مخزون فارغ) → +5 نقاط بدل`,
      });
      return res.json({ prize: prize.id, label: `كرت مجاني${extraMsg}`, points: 5, newPoints });
    }
  }

  if (prize.type === "loan") {
    // كرت سلفة مجاني من مخزون Selefny
    const loanPool = await pgDb.select().from(rewardCardsTable)
      .where(and(eq(rewardCardsTable.rewardType, "Selefny"), eq(rewardCardsTable.used, false)))
      .limit(1);

    if (loanPool.length > 0) {
      cardNumber = loanPool[0].username;
      await pgDb.update(rewardCardsTable)
        .set({ used: true, usedBy: userCode })
        .where(eq(rewardCardsTable.id, loanPool[0].id));
      await pgDb.insert(userLogsTable).values({
        userCode,
        message: `🎡 عجلة الحظ: كرت سلفة مجاني ${cardNumber}`,
      });
      return res.json({ prize: prize.id, label: prize.label, cardNumber, cardType: "Selefny" });
    } else {
      // فارغ → نقاط بدل
      extraMsg = " (مخزون فارغ → 3 نقاط بدل)";
      const newPoints = (user.points || 0) + 3;
      await pgDb.update(usersTable).set({ points: newPoints }).where(eq(usersTable.code, userCode));
      await pgDb.insert(userLogsTable).values({
        userCode,
        message: `🎡 عجلة الحظ: كرت سلفة (مخزون فارغ) → +3 نقاط بدل`,
      });
      return res.json({ prize: prize.id, label: `كرت سلفة${extraMsg}`, points: 3, newPoints });
    }
  }

  // prize.type === "luck" → حظ أوفر
  await pgDb.insert(userLogsTable).values({
    userCode,
    message: "🎡 عجلة الحظ: حظ أوفر!",
  });
  res.json({ prize: prize.id, label: prize.label });
});

export default router;
