import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import cardsRouter from "./cards";
import rewardsRouter from "./rewards";
import loansRouter from "./loans";
import chargeRouter from "./charge";
import adminRouter from "./admin";
import wheelRouter from "./wheel";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(cardsRouter);
router.use(rewardsRouter);
router.use(loansRouter);
router.use(chargeRouter);
router.use(adminRouter);
router.use(wheelRouter);

export default router;
