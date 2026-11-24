import express from "express";
import { requireAuth } from "../middleware/auth.js";
import * as controller from "../controllers/timetables.js";

const router = express.Router();

router.use(requireAuth);

router.post("/check", controller.checkClashes);
router.post("/generate", controller.generate);
router.post("/", controller.createTimetable);
router.get("/", controller.listTimetables);
router.get("/:id/calendar.ics", controller.downloadIcs);
router.get("/:id", controller.getTimetableById);
router.delete("/:id", controller.deleteTimetable);

export default router;
