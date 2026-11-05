// How the language model reads the bill test sentences (src/lib/speech-bill.eval-data.ts), and how
// long it takes. Nothing here touches the database.
//
//   LLM_URL=http://127.0.0.1:8080 npx tsx scripts/speech-llm-eval.ts            # llama.cpp
//   LLM_URL=http://127.0.0.1:11434 LLM_MODEL=qwen2.5:3b npx tsx scripts/speech-llm-eval.ts   # Ollama
import { billFromSpeech } from "../src/lib/speech-bill.js";
import { askModel, checkAnswer, chooseReading, rulesNeedHelp } from "../src/lib/speech-llm.js";
import { BILL_DEV_CASES, BILL_HELD_OUT_CASES, BILL_MEMBERS, gradeBill, type BillCase } from "../src/lib/speech-bill.eval-data.js";

if (!process.env.LLM_URL) {
  console.error("Set LLM_URL to the model server, for example http://127.0.0.1:8080");
  process.exit(1);
}
const names = BILL_MEMBERS.map((m) => m.name);
const speaker = BILL_MEMBERS.find((m) => m.isSpeaker)!.name;

async function run(label: string, cases: BillCase[]) {
  let rulesRight = 0;
  let modelRight = 0;
  let together = 0;
  let setAside = 0;
  const seconds: number[] = [];
  for (const c of cases) {
    const rules = billFromSpeech(c.text, names);
    const started = Date.now();
    const answer = await askModel(c.text, names, speaker, { timeoutMs: 120_000 });
    seconds.push((Date.now() - started) / 1000);
    const checked = answer ? checkAnswer(answer, c.text, names, speaker) : null;
    const model = checked?.ok ? checked.bill : null;
    if (gradeBill(rules, c).length === 0) rulesRight++;
    const modelWrong = model ? gradeBill(model, c) : null;
    if (modelWrong?.length === 0) modelRight++;
    if (!model) setAside++;
    // What the app does: ask the model only when the rules had trouble.
    const used = chooseReading(rules, rulesNeedHelp(rules) ? model : null).bill;
    const wrong = gradeBill(used, c);
    if (wrong.length === 0) together++;
    const why = !answer ? "no answer" : checked && !checked.ok ? `set aside: ${checked.reason}` : modelWrong?.length ? modelWrong.join("; ") : "right";
    console.log(`${wrong.length === 0 ? "✓" : "✗"} ${c.text.slice(0, 60)}…\n    model: ${why}`);
  }
  console.log(
    `${label}: rules ${rulesRight}/${cases.length}, model ${modelRight}/${cases.length} (${setAside} set aside), ` +
      `as the app uses them ${together}/${cases.length}. Seconds per bill: ${seconds.map((s) => s.toFixed(1)).join(" ")}\n`,
  );
}

await run("Tuning sentences", BILL_DEV_CASES);
await run("Held-out sentences", BILL_HELD_OUT_CASES);
