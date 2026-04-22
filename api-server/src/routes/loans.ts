import { Router, type IRouter } from "express";
import { RequestLoanBody } from "@workspace/api-zod";
import {
  db as pgDb,
  usersTable,
  loansTable,
  userLogsTable,
  rewardCardsTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

const router: IRouter = Router();
const LOAN_POINTS = 50;

// ─── طلب سلفة — يسحب من مخزون Selefny فقط ──────────────────────────────────
router.post("/loan", async (req, res): Promise<void> => {
  const parsed = RequestLoanBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { userCode } = parsed.data;

  const users = await pgDb.select().from(usersTable).where(eq(usersTable.code, userCode)).limit(1);
  if (users.length === 0) { res.status(400).json({ error: "المستخدم غير موجود" }); return; }
  const user = users[0];

  if ((user.points || 0) < 30) {
    res.status(400).json({
      error: `نقاطك الحالية ${user.points || 0} — تحتاج 30 نقطة على الأقل لاستخدام خدمة سلفني`,
    });
    return;
  }

  // سحب كرت من مخزون Selefny
  const pool = await pgDb.select().from(rewardCardsTable)
    .where(and(eq(rewardCardsTable.used, false), eq(rewardCardsTable.rewardType, "Selefny")))
    .orderBy(asc(rewardCardsTable.id))
    .limit(1);

  if (pool.length === 0) {
    res.status(400).json({ error: "لا توجد كروت Selefny متاحة — اطلب من المدير مزامنة الكروت من المايكروتيك" });
    return;
  }

  const cardNumber = pool[0].username;
  const rewardId = pool[0].id;

  // تعيين الكرت كمستخدم
  await pgDb.update(rewardCardsTable)
    .set({ used: true, usedBy: userCode, usedAt: new Date() })
    .where(eq(rewardCardsTable.id, rewardId));

  // خصم النقاط
  const pointsBefore = user.points || 0;
  const pointsAfter = pointsBefore - LOAN_POINTS;

  await pgDb.update(usersTable)
    .set({ points: pointsAfter })
    .where(eq(usersTable.code, userCode));

  await pgDb.insert(loansTable).values({
    userCode,
    amount: LOAN_POINTS,
    remaining: 0,
    cardUsername: cardNumber,
  });

  await pgDb.insert(userLogsTable).values({
    userCode,
    message: `سلفة كرت Selefny — رقم: ${cardNumber} — خُصم ${LOAN_POINTS} نقطة (${pointsBefore} ← ${pointsAfter})`,
  });

  res.json({
    username: cardNumber,
    cardNumber,
    cardValue: 100,
    loanAmount: LOAN_POINTS,
    userPoints: pointsAfter,
    loanProfile: "Selefny",
  });
});

export default router;
