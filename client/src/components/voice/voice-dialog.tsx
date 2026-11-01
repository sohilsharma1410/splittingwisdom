import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, Loader2, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/query-client";
import { MAX_RECORDING_SECONDS, useRecorder, useTranscribe } from "@/hooks/use-speech";

export interface VoiceOutcome<T> {
  /** One plain line per thing understood, shown before anything is applied. */
  summary: ReactNode[];
  doubts: string[];
  payload: T;
}

interface VoiceDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Shown while recording: what a good sentence sounds like. */
  example: string;
  applyLabel: string;
  groupId?: number;
  itemNames?: string[];
  /** Turns the transcript into suggestions. Runs again each time the transcript is edited. */
  interpret: (text: string) => Promise<VoiceOutcome<T>>;
  onApply: (payload: T, transcript: string) => void;
}

type Stage = "idle" | "recording" | "transcribing" | "review";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Record -> transcript you can edit -> what we understood -> Apply. Nothing is saved from here. */
export function VoiceDialog<T>({ open, onOpenChange, title, example, applyLabel, groupId, itemNames, interpret, onApply }: VoiceDialogProps<T>) {
  const recorder = useRecorder();
  const transcribe = useTranscribe();
  const [stage, setStage] = useState<Stage>("idle");
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<VoiceOutcome<T> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const run = useRef(0);

  // Each time the dialog opens, start from a clean slate and begin recording straight away.
  useEffect(() => {
    if (!open) { recorder.cancel(); return; }
    setText(""); setOutcome(null); setProblem(null); setStage("idle");
    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function begin() {
    setProblem(null);
    setStage("recording");
    await recorder.start();
  }

  // The recorder reports a blocked mic through `error`; fall back to typing.
  useEffect(() => {
    if (recorder.error && stage === "recording") { setProblem(recorder.error); setStage("review"); }
  }, [recorder.error, stage]);

  async function check(value: string) {
    const mine = ++run.current;
    setWorking(true);
    try {
      const result = await interpret(value);
      if (mine === run.current) { setOutcome(result); setProblem(null); }
    } catch (err) {
      if (mine === run.current) { setOutcome(null); setProblem(err instanceof ApiError ? err.message : "Couldn't work that out. Try again."); }
    } finally {
      if (mine === run.current) setWorking(false);
    }
  }

  async function finishRecording() {
    const audio = await recorder.stop();
    if (!audio) { setProblem("Nothing was recorded. Try again, or type it in."); setStage("review"); return; }
    setStage("transcribing");
    try {
      const { text: heard } = await transcribe.mutateAsync({ audio, groupId, itemNames });
      setText(heard);
      setStage("review");
      if (heard.trim()) await check(heard);
      else setProblem("Nothing was heard. Try again, closer to the microphone, or type it in.");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Couldn't read the recording. You can type it in instead.");
      setStage("review");
    }
  }

  const understood = outcome !== null && outcome.summary.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Nothing is saved until you confirm the bill.</DialogDescription>
        </DialogHeader>

        {stage === "recording" && !recorder.error && (
          <div className="space-y-4" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span className="relative flex h-3 w-3" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-coral" />
              </span>
              {recorder.state === "recording" ? <>Listening… <span className="tabular-currency" data-testid="voice-clock">{clock(recorder.seconds)}</span> / {clock(MAX_RECORDING_SECONDS)}</> : "Starting the microphone…"}
            </p>
            <p className="text-sm text-muted-foreground">For example: “{example}”</p>
            <div className="flex gap-2">
              <Button onClick={finishRecording} disabled={recorder.state !== "recording"}>
                <Square className="h-4 w-4" aria-hidden="true" />
                Done
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {stage === "transcribing" && (
          <p className="flex items-center gap-2 text-sm font-medium" role="status" aria-live="polite">
            <Loader2 className="h-4 w-4 animate-spin text-mint-ink" aria-hidden="true" />
            Listening back…
          </p>
        )}

        {stage === "review" && (
          <div className="space-y-4">
            {problem && (
              <p role="alert" className="flex items-start gap-2 text-sm text-coral-ink">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {problem}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="voice-transcript">What we heard (fix it if it's wrong)</Label>
              <textarea
                id="voice-transcript"
                value={text}
                onChange={(e) => { setText(e.target.value); setOutcome(null); }}
                rows={3}
                placeholder={`Type it here, like: “${example}”`}
                className="w-full rounded-lg border border-border bg-surface p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => check(text)} disabled={!text.trim() || working}>
                  {working && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Check this
                </Button>
                <Button size="sm" variant="ghost" onClick={begin}>
                  <Mic className="h-4 w-4" aria-hidden="true" />
                  Record again
                </Button>
              </div>
            </div>

            {outcome && (
              <section aria-label="What we understood" className="space-y-2 rounded-xl border border-border bg-surface p-3">
                {understood ? (
                  <ul className="space-y-1 text-sm">{outcome.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing could be filled in from that.</p>
                )}
                {outcome.doubts.length > 0 && (
                  <ul className="space-y-1 text-sm text-warn">
                    {outcome.doubts.map((d, i) => (
                      <li key={i} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{d}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <div className="flex flex-wrap gap-2">
              <Button disabled={!understood || working} onClick={() => { onApply(outcome!.payload, text); onOpenChange(false); }}>{applyLabel}</Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
