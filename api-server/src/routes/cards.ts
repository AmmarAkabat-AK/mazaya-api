import { Router, type IRouter } from "express";
import { AddCardBody } from "@workspace/api-zod";
import {
  db as pgDb,
  loansTable,
  usedCardsTable,
  usersTable,
  vouchersTable,
} from "@workspace/db";
import { and, desc, eq, gt } from "drizzle-orm";

const router: IRouter = Router();

const POINTS_TABLE: Record<number, number> = {
  50: 1,
  100: 5,
  200: 10,
  300: 15,
  500: 20,
  1000: 40,
};

function getPointsForValue(value: number): number {
  return POINTS_TABLE[value] ?? Math.floor(value / 20);
}

router.post("/addCard", async (req, res): Promise<void> => {
  const parsed = AddCardBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "بيانات غير صالحة" });
    return;
  }

  const userCode = String(parsed.data.userCode).trim();

  const cleanCard = String(parsed.data.cardNumber).trim().replace(/[^\d]/g, "");

  if (!userCode || !cleanCard) {
    res.status(400).json({ error: "اكتب البيانات" });
    return;
  }

  const users = await pgDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.code, userCode))
    .limit(1);

  if (!users.length) {
    res.status(400).json({ error: "❌ المستخدم غير موجود" });
    return;
  }

  const alreadyUsed = await pgDb
    .select()
    .from(usedCardsTable)
    .where(eq(usedCardsTable.cardNumber, cleanCard))
    .limit(1);

  if (alreadyUsed.length) {
    res.status(400).json({ error: "❌ هذا الكرت تمت إضافة نقاطه من قبل" });
    return;
  }

  const vouchers = await pgDb
    .select()
    .from(vouchersTable)
    .where(eq(vouchersTable.cardNumber, cleanCard))
    .limit(1);

  if (!vouchers.length) {
    res.status(400).json({ error: "❌ الكرت غير موجود في النظام" });
    return;
  }

  const user = users[0];
  const voucher: any = vouchers[0];

  const isUsed =
    voucher.used === true ||
    voucher.used === "true" ||
    voucher.used === "t" ||
    voucher.used === 1;

  if (isUsed) {
    res.status(400).json({
      error: "❌ هذا الكرت مستخدم أو منتهي ولا يمكن إضافة نقاطه",
    });
    return;
  }

  const cardValue = voucher.value;
  let pointsToAdd = getPointsForValue(cardValue);

  const loans = await pgDb
    .select()
    .from(loansTable)
    .where(and(eq(loansTable.userCode, userCode), gt(loansTable.remaining, 0)))
    .orderBy(desc(loansTable.createdAt))
    .limit(1);

  const activeLoan = loans.length ? loans[0] : null;
  let loanRemaining = 0;

  if (activeLoan && activeLoan.remaining > 0) {
    const deduction = Math.min(pointsToAdd, activeLoan.remaining);

    pointsToAdd -= deduction;
    loanRemaining = activeLoan.remaining - deduction;

    await pgDb
      .update(loansTable)
      .set({ remaining: loanRemaining })
      .where(eq(loansTable.id, activeLoan.id));
  }

  const newPoints = user.points + pointsToAdd;

  await pgDb.transaction(async (txDb) => {
    await txDb
      .update(vouchersTable)
      .set({
        used: true,
        usedBy: userCode,
        usedAt: new Date(),
      })
      .where(eq(vouchersTable.id, voucher.id));

    await txDb
      .update(usersTable)
      .set({ points: newPoints })
      .where(eq(usersTable.code, userCode));

    await txDb.insert(usedCardsTable).values({
      cardNumber: cleanCard,
      userCode,
      cardValue,
      pointsAdded: pointsToAdd,
    });
  });

  res.json({
    pointsAdded: pointsToAdd,
    newPoints,
    loanRemaining,
  });
});

export default router;
