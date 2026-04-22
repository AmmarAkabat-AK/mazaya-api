import { Router, type IRouter } from "express";
import { GetUserParams } from "@workspace/api-zod";
import { getUserData } from "./auth";

const router: IRouter = Router();

router.get("/user/:code", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const userData = await getUserData(params.data.code);
  if (!userData) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }

  res.json(userData);
});

export default router;
