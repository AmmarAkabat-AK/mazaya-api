import { Router, type IRouter } from "express";
import { CreateUserBody, LoginUserBody, RecoverCodeBody } from "@workspace/api-zod";
import {
  db as pgDb,
  usersTable,
  loansTable,
  userLogsTable,
} from "@workspace/db";
import { eq, and, gt, desc } from "drizzle-orm";

const router: IRouter = Router();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function getUserData(code: string) {
  const users = await pgDb.select().from(usersTable).where(eq(usersTable.code, code)).limit(1);
  if (users.length === 0) return null;
  const user = users[0];

  // Get active loan (remaining > 0)
  const loans = await pgDb.select().from(loansTable)
    .where(and(eq(loansTable.userCode, code), gt(loansTable.remaining, 0)))
    .orderBy(desc(loansTable.createdAt))
    .limit(1);
  const activeLoan = loans.length > 0 ? loans[0] : null;

  // Get last 30 logs
  const logRows = await pgDb.select().from(userLogsTable)
    .where(eq(userLogsTable.userCode, code))
    .orderBy(desc(userLogsTable.createdAt))
    .limit(30);
  const logs = logRows.map(l => l.message).reverse();

  return {
    name: user.name,
    code: user.code,
    points: user.points,
    logs,
    ...(activeLoan ? {
      loan: {
        remaining: activeLoan.remaining,
        amount: activeLoan.amount,
        card_username: activeLoan.cardUsername,
      }
    } : {}),
  };
}

router.post("/createUser", async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "اكتب البيانات" }); return; }

  const { name, password } = parsed.data;
  if (!name || !password) { res.status(400).json({ error: "اكتب البيانات" }); return; }

  // Generate unique code
  let code = generateCode();
  for (let i = 0; i < 10; i++) {
    const exists = await pgDb.select().from(usersTable).where(eq(usersTable.code, code)).limit(1);
    if (exists.length === 0) break;
    code = generateCode();
  }

  await pgDb.insert(usersTable).values({ code, name, password, points: 0 });
  await pgDb.insert(userLogsTable).values({ userCode: code, message: "تم إنشاء الحساب" });

  res.status(201).json({ success: true, code });
});

router.post("/login", async (req, res): Promise<void> => {
  const parsed = LoginUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "اكتب البيانات" }); return; }

  const { code, password } = parsed.data;
  if (!code || !password) { res.status(401).json({ error: "اكتب البيانات" }); return; }

  const users = await pgDb.select().from(usersTable)
    .where(and(eq(usersTable.code, code), eq(usersTable.password, password)))
    .limit(1);

  if (users.length === 0) {
    res.status(401).json({ error: "❌ الكود خطأ" });
    return;
  }

  const userData = await getUserData(code);
  res.json({ user: userData });
});

router.post("/recoverCode", async (req, res): Promise<void> => {
  const parsed = RecoverCodeBody.safeParse(req.body);
  if (!parsed.success) { res.status(404).json({ error: "اكتب البيانات كاملة" }); return; }

  const { name, password } = parsed.data;
  if (!name || !password) { res.status(404).json({ error: "اكتب البيانات كاملة" }); return; }

  const users = await pgDb.select().from(usersTable)
    .where(and(eq(usersTable.name, name), eq(usersTable.password, password)))
    .limit(1);

  if (users.length === 0) {
    res.status(404).json({ error: "لم يتم العثور على حساب بهذه البيانات" });
    return;
  }
  res.json({ code: users[0].code });
});

export default router;
