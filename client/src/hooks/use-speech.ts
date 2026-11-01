// Speech to text (plan D4.10-D4.12): record on the phone, send to the server, get text back,
// then turn the text into suggestions. Nothing here saves anything. The mic is hidden when the
// server can't do speech (for example on the standby) or the browser can't record.
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query-client";
import type { ReceiptExtraction } from "@/hooks/use-bills";

export const MAX_RECORDING_SECONDS = 60;

export interface SpokenAssignment {
  itemIndex: number;
  shares: { memberId: number; units: number }[];
}
export interface AssignInterpretation {
  assignments: SpokenAssignment[];
  doubts: string[];
}
export interface BillInterpretation {
  extraction: ReceiptExtraction;
  doubts: string[];
}
export interface SpokenItemRef {
  index: number;
  name: string;
  quantity: number;
}

export function canRecord(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/** Whether to show a mic at all: the server can read speech and this browser can record. */
export function useSpeechAvailable(): boolean {
  const status = useQuery({
    queryKey: ["speech", "status"],
    queryFn: () => apiFetch<{ available: boolean }>("/api/speech/status"),
    staleTime: 60_000,
    retry: false,
  });
  return canRecord() && status.data?.available === true;
}

export function useTranscribe() {
  return useMutation({
    mutationFn: async (input: { audio: Blob; groupId?: number; itemNames?: string[] }) => {
      const form = new FormData();
      form.append("audio", input.audio, "recording");
      if (input.groupId !== undefined) form.append("groupId", String(input.groupId));
      if (input.itemNames?.length) form.append("items", JSON.stringify(input.itemNames.slice(0, 60)));
      return apiFetch<{ text: string }>("/api/speech/transcribe", { method: "POST", body: form });
    },
  });
}

export function useInterpretAssign() {
  return useMutation({
    mutationFn: (input: { text: string; groupId: number; items: SpokenItemRef[]; itemIndex?: number }) =>
      apiFetch<AssignInterpretation>("/api/speech/interpret", { method: "POST", body: JSON.stringify({ mode: "assign", ...input }) }),
  });
}

export function useInterpretBill() {
  return useMutation({
    mutationFn: (input: { text: string }) =>
      apiFetch<BillInterpretation>("/api/speech/interpret", { method: "POST", body: JSON.stringify({ mode: "bill", ...input }) }),
  });
}

const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export type RecorderState = "idle" | "starting" | "recording";

/** One recording at a time. `stop()` resolves with the audio; `cancel()` throws it away. */
export function useRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const finish = useRef<((blob: Blob | null) => void) | null>(null);

  const release = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
    setState("idle");
  }, []);

  useEffect(() => () => { // leaving the screen mid-recording must turn the mic off
    if (recorder.current && recorder.current.state !== "inactive") { finish.current = null; recorder.current.stop(); }
    release();
  }, [release]);

  const start = useCallback(async () => {
    setError(null);
    setSeconds(0);
    setState("starting");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = MIME_PREFERENCE.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      rec.onstop = () => {
        const blob = chunks.current.length ? new Blob(chunks.current, { type: rec.mimeType || mimeType || "audio/webm" }) : null;
        const done = finish.current;
        finish.current = null;
        release();
        done?.(blob);
      };
      recorder.current = rec;
      rec.start();
      setState("recording");
      timer.current = window.setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_RECORDING_SECONDS && recorder.current?.state === "recording") recorder.current.stop();
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      release();
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "The microphone is blocked. Allow it in your browser settings, or type it in instead."
          : name === "NotFoundError"
            ? "No microphone was found. You can type it in instead."
            : "Couldn't start the microphone. You can type it in instead.",
      );
    }
  }, [release]);

  const stop = useCallback(
    () => new Promise<Blob | null>((resolve) => {
      if (!recorder.current || recorder.current.state === "inactive") return resolve(null);
      finish.current = resolve;
      recorder.current.stop();
    }),
    [],
  );

  const cancel = useCallback(() => {
    finish.current = null;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    else release();
  }, [release]);

  return { state, seconds, error, start, stop, cancel };
}
