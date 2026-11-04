import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { groupMembers } from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getMembership } from "../middleware/authorize.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { buildPrompt, sttAvailable, transcribe } from "../lib/speech-stt.js";
import { splitFromSpeech, type SpeechMember } from "../lib/speech-split.js";
import { billFromSpeech } from "../lib/speech-bill.js";

const router = Router();
router.use(requireAuth);

// About 60 seconds of phone audio is well under 1 MB; this leaves room for a better codec setting.
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 4 } });

async function loadMembers(groupId: number, userId: number): Promise<SpeechMember[] | null> {
  if (!(await getMembership(userId, groupId))) return null;
  const rows = await db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId));
  // Only people with an account can be assigned to an item.
  return rows.filter((m) => m.userId !== null).map((m) => ({ id: m.id, name: m.displayName, isSpeaker: m.userId === userId }));
}

// Whether speech works on this server. The client hides the mic when it doesn't (for example
// on the standby, which can't run it).
router.get("/status", async (_req, res) => {
  res.json({ data: { available: await sttAvailable() } });
});

const transcribeFields = z.object({
  groupId: z.coerce.number().int().positive().optional(),
  items: z.string().max(4000).optional(),
});

router.post("/transcribe", rateLimit({ max: 40, windowMs: 60 * 60 * 1000, message: "Too many recordings this hour. Try again later, or type it in." }), (req, res, next) => {
  audioUpload.single("audio")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: { message: "That recording is too long. Keep it under a minute." } });
      return;
    }
    next(err);
  });
}, async (req, res) => {
  if (!req.file || req.file.size < 200) {
    res.status(400).json({ error: { message: "No recording was received." } });
    return;
  }
  const fields = transcribeFields.safeParse(req.body);
  if (!fields.success) {
    res.status(400).json({ error: { message: "That request wasn't valid." } });
    return;
  }

  let memberNames: string[] = [];
  if (fields.data.groupId !== undefined) {
    const members = await loadMembers(fields.data.groupId, req.session.userId!);
    if (!members) {
      res.status(404).json({ error: { message: "Group not found." } });
      return;
    }
    memberNames = members.map((m) => m.name);
  }
  let itemNames: string[] = [];
  if (fields.data.items) {
    try {
      const parsed = z.array(z.string().max(80)).max(60).parse(JSON.parse(fields.data.items));
      itemNames = parsed;
    } catch {
      res.status(400).json({ error: { message: "That request wasn't valid." } });
      return;
    }
  }

  const result = await transcribe(req.file.buffer, req.file.mimetype, buildPrompt(memberNames, itemNames));
  if (!result.ok) {
    const failure = {
      unavailable: [503, "Speech isn't available right now. You can type it in instead."],
      "too-long": [413, "That recording is too long. Keep it under a minute."],
      unreadable: [422, "That recording couldn't be read. Try again."],
    }[result.reason] as [number, string];
    res.status(failure[0]).json({ error: { message: failure[1] } });
    return;
  }
  res.json({ data: { text: result.text } });
});

const itemSchema = z.object({ index: z.number().int().min(0), name: z.string().min(1).max(200), quantity: z.number().int().min(1).max(999) });
const interpretSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("assign"), text: z.string().max(1500), groupId: z.number().int().positive(), items: z.array(itemSchema).min(1).max(100), itemIndex: z.number().int().min(0).optional() }),
  z.object({ mode: z.literal("bill"), text: z.string().max(3000), groupId: z.number().int().positive().optional() }),
]);

// Text in, suggestions out. Used when someone edits the transcript, so the audio isn't sent twice.
router.post("/interpret", rateLimit({ max: 200, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const parsed = interpretSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "That request wasn't valid." } });
    return;
  }
  const input = parsed.data;

  if (input.mode === "bill") {
    // With a group, "Thali 140 Bob and Cat" also says who had it, read the same way as "assign by voice".
    const groupMembers = input.groupId !== undefined ? await loadMembers(input.groupId, req.session.userId!) : null;
    if (input.groupId !== undefined && !groupMembers) {
      res.status(404).json({ error: { message: "Group not found." } });
      return;
    }
    const bill = billFromSpeech(input.text, groupMembers?.map((m) => m.name) ?? []);
    const assignments: { itemIndex: number; shares: { memberId: number; units: number }[] }[] = [];
    if (groupMembers) {
      bill.items.forEach((item, itemIndex) => {
        if (!item.who) return;
        const result = splitFromSpeech(`zzitem ${item.who}`, [{ index: itemIndex, name: "zzitem", quantity: item.quantity }], groupMembers);
        const shares = result.assignments[itemIndex];
        if (shares) assignments.push({ itemIndex, shares: Object.entries(shares).map(([memberId, units]) => ({ memberId: Number(memberId), units })) });
        bill.doubts.push(...result.doubts.map((doubt) => `${item.name}: ${doubt}`));
      });
    }
    const subtotal = bill.items.reduce((sum, item) => sum + item.price, 0);
    res.json({
      data: {
        extraction: {
          merchant: bill.merchant,
          billDate: null,
          items: bill.items,
          subtotalAmount: subtotal || null,
          taxAmount: bill.taxAmount,
          tipAmount: bill.tipAmount,
          serviceFeeAmount: bill.serviceFeeAmount,
          discountAmount: bill.discountAmount,
          roundOffAmount: null,
          totalAmount: bill.totalAmount,
          overallConfidence: bill.items.length > 0 ? "high" : "low",
          totalsMismatch: null,
        },
        assignments,
        doubts: bill.doubts,
      },
    });
    return;
  }

  const members = await loadMembers(input.groupId, req.session.userId!);
  if (!members) {
    res.status(404).json({ error: { message: "Group not found." } });
    return;
  }
  // Per item: the sentence is only about people, so give the matcher a stand-in item to hang them on.
  const single = input.itemIndex !== undefined ? input.items.find((i) => i.index === input.itemIndex) : undefined;
  if (input.itemIndex !== undefined && !single) {
    res.status(400).json({ error: { message: "That request wasn't valid." } });
    return;
  }
  const result = single
    ? splitFromSpeech(`zzitem ${input.text}`, [{ index: single.index, name: "zzitem", quantity: single.quantity }], members)
    : splitFromSpeech(input.text, input.items, members);
  res.json({
    data: {
      assignments: Object.entries(result.assignments).map(([itemIndex, shares]) => ({
        itemIndex: Number(itemIndex),
        shares: Object.entries(shares).map(([memberId, units]) => ({ memberId: Number(memberId), units })),
      })),
      doubts: result.doubts,
    },
  });
});

export default router;
