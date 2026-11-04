# Voice workflow: assigning items to people

The main job: after items exist (scanned or typed), say who had what, and have the app fill the assignments for the person to check. Amounts never come from speech. Only item numbers, member ids and share counts do. Plan tasks: D4.9–D4.12.

## The idea: the vocabulary is closed

The app knows every name it could hear (the group's members) and, on the review screen, every item. So it doesn't need to recognise open speech. It needs to answer "which of these people or items does this sound like?" Three places use that:

1. **Tell the recogniser the words.** The server builds the Whisper prompt from the database (group members, plus the item names of the bill being edited), never from what the client sends. The D4.9 test measured this: names and dishes kept went from 171/420 to 359/420 on `tiny.en`.
2. **Match by sound, not spelling.** `server/src/lib/speech-names.ts`: a consonant skeleton plus a spelling check, so "Karen" finds Karan and "Pria" finds Priya. Exact names win over similar ones. When two members sound alike ("Karan" and "Kiran"), the result is ambiguous and nothing is guessed.
3. **Ask, don't guess.** An ambiguous or unknown word leaves the item blank and says why in words ("Couldn't tell who \"xyz\" is", "More than one person could be \"Kar\""). A tap-to-choose picker is not built.

## Two ways to speak

| | Whole bill | Per item |
|---|---|---|
| Where | One mic at the top of the items list | A small mic on each item row |
| Says | "Pizza to Ravi, fries between me and Asha, everyone shared the biryani" | "Ravi and me" |
| Vocabulary | People + items | People only |
| Accuracy | Lower: dishes are hard to hear, and sentences get long | Highest: a handful of names |
| Best for | A quick first pass | Fixing what the first pass missed, or when the room is noisy |

Build the whole-bill mic first (it's what D4.11 and D4.12 describe), and add the per-item mic as a thin variant of it: same endpoint, same transcript box, with the item fixed and the matcher told to look only for people.

## Steps for the person

1. Tap the mic and speak. Show the recording time, with a stop button.
2. The audio goes to the `stt` container on the Pi, is read, and is deleted straight away.
3. An editable transcript appears. Editing it re-runs the matching without sending audio again.
4. Under each item, chips show who it was matched to. Anything unclear is listed with the reason and left blank.
5. **Apply** fills the assignments. Nothing is saved until the normal **Confirm**. One tap undoes it.

## What's built (branch `dev-voice-names`)

| Piece | Where |
|---|---|
| `stt` container (faster-whisper `base.en`, int8, 3 threads, no retries; no internet, no Postgres, no host port, read-only, 1500 MB cap) | `deploy/pi/stt/`, service in `deploy/pi/docker-compose.yml` |
| `GET /api/speech/status`, `POST /api/speech/transcribe`, `POST /api/speech/interpret` | `server/src/routes/speech.ts` |
| Prompt built on the server from the group's people and the bill's items | `server/src/lib/speech-stt.ts` |
| Name matching by sound; unknown name before "had" holds the sentence back | `server/src/lib/speech-names.ts`, `speech-split.ts` |
| Bill details by voice: items, quantity, price (each or in all), tax, tip, service, discount, percentages, total | `server/src/lib/speech-bill.ts`, `speech-numbers.ts` |
| Mic dialog: record, editable transcript, "what we understood", Apply | `client/src/components/voice/voice-dialog.tsx`, `hooks/use-speech.ts` |
| Entry points: **Speak the bill** (New Bill dialog and the scan page), **Assign by voice** (scan review and saved bills), per-item mic on every row | `scan-bill.tsx`, `bill-detail.tsx`, `bill-form-dialog.tsx` |

`STT_URL` turns speech on. Unset (Render and Vercel) hides every mic, and the app works as before.

**Money from speech.** Speaking the bill is the one place amounts come from speech. They are read as whole paise with integer maths only, shown on the same review screen as a photo scan, and checked against the total the person said. A line where "2 naan 160" could mean each or in all is marked "check this line" and uses the line total. Assigning by voice never touches amounts: only people and share counts.

## Tested

- 30 matcher tests, 14 bill-by-voice tests, 13 route tests (auth, other people's groups, limits, service down), 6 browser tests (speak a bill and save it, assign after a scan, per item, saved bill, accessibility in light and dark at 360px).
- **Real speech recognition on a Mac** (Whisper `base.en`, text-to-speech voices Samantha, Rishi and Daniel, 6 sentences each, 18 per setting): names kept 13/30 without the group's names in the prompt, 28/30 with them. Through the whole matcher: without the prompt 5 exact, 10 left blank, 3 wrong; with it 17 exact, 1 left blank, **0 wrong**.
- Not real people: the voices are synthetic. Real phone recordings of friends at a table are still the test that counts.

## Not built

Nicknames ("Sid" for Siddharth), which need a migration, and tap-to-choose between two similar names (it explains the doubt in words and leaves the item for you to assign).

## Saying who had what while speaking the bill

A dictated item can carry who had it: "Thali 140, Bob and Cat", "Curd shared by me 50", "Chicken tikka 250. Only Bob." The dish keeps its own name; the people part is read by the same matcher as "Assign by voice" (names by sound, ambiguity left blank with a reason). The group is only known on the review screen when the bill wasn't started from a group, so the review screen reads the spoken text again once the group is chosen, fills the rows' people (and tidies a dish name that picked up a person's name), and lists anything it couldn't place. Nothing is saved until the normal Confirm.
