import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { receiptsDir, receiptSigningSecret, storageDriver } from "../lib/storage.js";
import { verifyReceiptToken } from "../lib/storage-local.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/receipts/:token — streams a receipt image under the local storage
// driver. This is the "signed URL" GET /api/bills/:id/receipt-url hands out:
// that route checks group membership before issuing a token, the token
// expires in 10 minutes, and the caller must also be logged in. Every failure
// is the same 404, so the route doesn't reveal which receipts exist.
// ---------------------------------------------------------------------------
router.get("/:token", requireAuth, (req, res, next) => {
  const notFound = () => res.status(404).json({ error: { message: "Receipt not found." } });

  if (storageDriver() !== "local") {
    notFound();
    return;
  }
  const receiptPath = verifyReceiptToken(String(req.params.token), receiptSigningSecret());
  if (!receiptPath) {
    notFound();
    return;
  }

  res.sendFile(
    receiptPath,
    {
      root: receiptsDir(),
      etag: false,
      lastModified: false,
      headers: { "Cache-Control": "private, no-store" },
    },
    (err) => {
      if (!err) return;
      if (res.headersSent) {
        res.destroy();
      } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        notFound();
      } else {
        next(err);
      }
    },
  );
});

export default router;
