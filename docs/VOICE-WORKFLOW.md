# Voice workflow: assigning items to people

The main job: after items exist (scanned or typed), say who had what, and have the app fill the assignments for the person to check. Amounts never come from speech. Only item numbers, member ids and share counts do. Plan tasks: D4.9–D4.12.

## The idea: the vocabulary is closed

The app knows every name it could hear (the group's members) and, on the review screen, every item. So it doesn't need to recognise open speech. It needs to answer "which of these people or items does this sound like?" Three places use that:

1. **Tell the recogniser the words.** The server builds the Whisper prompt from the database (group members, plus the item names of the bill being edited), never from what the client sends. The D4.9 test measured this: names and dishes kept went from 171/420 to 359/420 on `tiny.en`.
2. **Match by sound, not spelling.** `server/src/lib/speech-names.ts`: a consonant skeleton plus a spelling check, so "Karen" finds Karan and "Pria" finds Priya. Exact names win over similar ones. When two members sound alike ("Karan" and "Kiran"), the result is ambiguous and nothing is guessed.
3. **Ask, don't guess.** An ambiguous or unknown word becomes a tappable choice on the review screen ("Which one? Karan / Kiran") instead of a silent blank.

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
4. Under each item, chips show who it was matched to. Anything unclear is a highlighted word with the choices.
5. **Apply** fills the assignments. Nothing is saved until the normal **Confirm**. One tap undoes it.

## What's still needed

| Need | Task | Notes |
|---|---|---|
| Run the speed test on the Pi itself | D4.9 | The numbers so far are x86. The owner approves the Pi numbers before any app code. |
| Isolated `stt` container | D4.10 | Like `ocr`: no internet, no route to Postgres, limits, models fetched at build. |
| `POST /api/speech/transcribe` | D4.10 | Auth, rate limit, size and length limits. Takes audio and a group (and optionally a bill's items). Builds the prompt itself. Never logs audio or text. |
| `POST /api/speech/split` | D4.12 | Takes text, a group and the bill's items. Returns assignments, doubts and the ambiguous words. Used when the transcript is edited. |
| Mic on the review screen and the bill's item list | D4.11 | MediaRecorder; denied mic, unsupported browser, failure and "unavailable on the standby" all fall back to hand entry. |
| Per-item mic | D4.11 | See above. |
| Alias table ("Sid" for Siddharth) | Backlog | Needs a migration, so it's the owner's call. Sound matching covers most of this first. |

## What's tested so far

`speech-names.test.ts`: usual mishearings of eight names match; everyday words and different names don't; in a sentence a misspelt name is assigned only when one person sounds like it, and left blank (with a doubt) when two do. The earlier `speech-split` sentence tests are unchanged: no wrong guesses.

**Not yet tested:** real audio. Misspellings in the tests were written by hand. The next test is text-to-speech clips run through Whisper with and without the group's names in the prompt, then through this matcher.
