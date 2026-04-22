import { Router, type IRouter } from "express";
import { SubmitChargeRequestBody, GetChargeHistoryParams } from "@workspace/api-zod";
import {
  db as pgDb,
  usersTable,
  chargeRequestsTable,
  userLogsTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { sendSmsViaRouter } from "../smsHelper";

const router: IRouter = Router();

router.post("/chargeRequest", async (req, res): Promise<void> => {
  const parsed = SubmitChargeRequestBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "❌ جميع الحقول مطلوبة" }); return; }

  const { userCode, service, amount, phone, txnRef } = parsed.data;

  const users = await pgDb.select().from(usersTable).where(eq(usersTable.code, userCode)).limit(1);
  if (users.length === 0) { res.status(400).json({ error: "المستخدم غير موجود" }); return; }
  const user = users[0];

  const result = await pgDb.insert(chargeRequestsTable).values({
    userCode, service, amount, phone,
    txnRef: txnRef || null,
    status: "pending",
  }).returning({ id: chargeRequestsTable.id });

  await pgDb.insert(userLogsTable).values({
    userCode,
    message: `طلب شحن كرت ابو ${amount} ريال — ${service} — ${phone}`,
  });

  // إرسال SMS للأدمن إشعاراً بالطلب الجديد
  const smsMsg = `طلب شحن جديد\nالمستخدم: ${user.name} (${userCode})\nالخدمة: ${service}\nالمبلغ: ${amount} ريال\nهاتف العميل: ${phone}`;
  sendSmsViaRouter(smsMsg).catch(() => {});

  res.status(201).json({ success: true, id: String(result[0].id) });
});

router.get("/chargeHistory/:code", async (req, res): Promise<void> => {
  const params = GetChargeHistoryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const rows = await pgDb.select().from(chargeRequestsTable)
    .where(eq(chargeRequestsTable.userCode, params.data.code))
    .orderBy(desc(chargeRequestsTable.createdAt));

  res.json(rows.map(r => ({
    id: String(r.id),
    service: r.service,
    amount: r.amount,
    phone: r.phone,
    txnRef: r.txnRef || "",
    status: r.status,
    assignedCard: r.assignedCard || null,
    adminNote: r.adminNote || null,
    createdAt: r.createdAt?.toISOString() ?? "",
  })));
});

export default router;
