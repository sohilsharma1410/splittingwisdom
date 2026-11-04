# Voice on the Pi: handover

For the Pi developer taking this over. Everything runs **on the Pi with a local model**: speech is recognised by faster-whisper `base.en` inside the `stt` container, and the words are turned into assignments by plain rules in the API (`server/src/lib/speech-*.ts`). No cloud, no key, no language model, nothing leaves the Pi. Background and measurements: `docs/VOICE-WORKFLOW.md`, `docs/PI-STATUS.md`.

## 1. Bring it up

```bash
git pull origin main
cd deploy/pi
docker compose build stt api      # downloads base.en (about 145 MB) once, into the image
docker compose up -d
docker compose ps                 # stt and api must both say "healthy"
```

- `STT_URL: http://stt:8000` is already set on the `api` service. There is no key and no migration.
- `stt` is on an internal-only network (no internet, no Postgres, no host port), read-only, 1500 MB cap, cores 0–2 (shared with `ocr`).
- If `stt` is down or `STT_URL` is unset, the API reports speech unavailable and **every mic is hidden**; the app works as before. Render and Vercel have no `STT_URL`, so they never show a mic.

Quick checks, from the Pi:

```bash
curl -s http://127.0.0.1:4000/api/health/db                       # API alive
docker compose exec stt python -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8000/health').read())"
```

Signed in, `GET /api/speech/status` returns `{"data":{"available":true}}`. Opening the app on a phone over HTTPS shows mic icons (browsers only allow the microphone on HTTPS or localhost).

## 2. What a person can do (exact use cases)

All of these end on a review screen. **Nothing is saved until the person presses Confirm** (on a saved bill, *Assign* saves the assignments straight away). Money only ever comes from spoken *prices*; assigning never touches amounts.

### A. Speak the whole bill (New Bill → "Speak the bill instead", or Scan page → "Speak the bill")

Say items, quantity, price, charges and total. Examples and what they give:

| Say | You get |
|---|---|
| "Two paneer tikka 250 each, naan 80, GST 5 percent, total 630" | 2 × Paneer Tikka ₹500 (₹250 each), Naan ₹80, tax 5% of ₹580 = ₹29, total check: you said ₹630, screen says *off by ₹21.00* |
| "Four naan for sixty" | 4 × Naan, line total ₹60 |
| "2 naan 160" | 2 × Naan, **₹160 as the line total, flagged "check this line"** (can't tell each from in all) |
| "Bill name Ganbei, butter chicken three hundred and fifty" | bill name Ganbei, Butter Chicken ₹350 |
| "Tip 10 percent, service charge 5 percent, discount 50" | percentages are of the item prices said so far, in whole paise |

### B. Say who had it, in the same breath

Add the people after the dish. The dish keeps its own name.

| Say | You get |
|---|---|
| "Chicken tikka 250. Only Bob." | Chicken Tikka → Bob |
| "Curd shared by me 50" | Curd ₹50 → the speaker |
| "Thali 140, Bob and Cat" | Thali → Bob, Cat |
| "Naan 80 for Cat" | Naan → Cat |
| "Chicken lollipop 250 shared by everyone" | everyone |

How the group is known: from a group page or the New Bill dialog it's known up front. Otherwise the bill is parsed first, then **re-read when a group is chosen** on the review screen, which fills the rows (and trims a person's name off a dish name that picked it up, like "Thali Priya" → "Thali").

### C. Assign by voice on a scanned (or spoken) bill: whole bill

On the review screen, **Assign by voice**. Examples (items on the bill: Vodka Prawns, Veg Stew, …):

| Say | You get |
|---|---|
| "Ravi had the vodka prawns and priya and I shared the veg stew" | Vodka Prawns → Ravi; Veg Stew → Priya and the speaker |
| "Everyone shared the biryani" | Biryani → all members |
| "Everyone except Karan shares the chaas" | Chaas → all but Karan |
| "Two naans for me two for Priya" | Naan split by units 2 and 2 (counts must add up to the quantity, else it asks to check) |
| "I had the soda and everything else was shared" | Soda → speaker, every other unnamed item → everyone |
| "Biryani ravi ko do, chaas main aur priya mein baant do" | works for common Hindi phrasing too |

An unrecognised spoken name is **never guessed**: the sentence is held back and the review box says "Couldn't tell who "xyz" is". Two members who sound alike (Karan and Kiran) leave the item blank with a message.

### D. Assign by voice: per item

The small mic on an item row: say only people. "Bob and me", "Priya", "everyone". Most accurate (a handful of names).

### E. Assign by voice on a saved bill (bill page)

Same two mics. *Assign* applies and saves.

### Things it deliberately refuses (leaves blank and says why)

"Karan didn't have the naan" (negation), "Ravi paid for the biryani" (paying is set separately), "maybe Ravi had the chaas" (unsure), "we shared the naan" ("we" is unknown), "the sweet dish was for Priya" (a description, not a name). The person assigns those by hand.

### Editing what was heard

The dialog shows the transcript in an editable box. Fix a word, press **Check this**: the text is re-interpreted without sending the audio again.

## 3. Alerts and states on the screen

| Situation | What the person sees |
|---|---|
| Mic not available (server has no `STT_URL`, or browser can't record) | No mic buttons anywhere; the app is unchanged |
| **No group chosen yet** (several groups, none selected) | Info note under *Items*: "Choose a group above to fill in who had what from what you said, or to say who had what by voice." (the first half only if they spoke people) |
| Group has no members with an account | Note: "No one in this group has an account yet, so people can't be assigned by voice. Everyone shares each item." |
| **Group changed after people were assigned** | People are cleared (they belonged to the old group) and a warning says so |
| Assigned person isn't in the chosen group at Confirm | Confirm is blocked with a message naming the item; "Everyone" clears it |
| Something couldn't be placed (unknown name, ambiguous name, counts don't add up) | Listed under "What you said" and in the dialog's "What we understood" |
| Mic blocked / none found | Plain message in the dialog, "you can type it in instead" |
| Recording over 60 s or 3 MB | Stops at 60 s; the server answers 413 with "keep it under a minute" |
| `stt` down, slow or the recording unreadable | 503/422 with a message and the transcript box stays editable so they can type |
| Too many recordings (40/hour/user) | "Too many recordings this hour. Try again later, or type it in." |
| Spoken total differs from the sum | The same "Totals don't match … off by ₹X" banner as a scan |
| Not a member of the group | 404 "Group not found." (cannot read others' groups) |

## 4. How it works, in one screen

```
phone mic ──audio──▶ API /api/speech/transcribe ──▶ stt container (Whisper base.en, local)
                      │  prompt = group's names + bill's item names, read from the DB (never from the client)
                      ▼
                    text ──▶ /api/speech/interpret
                      mode "assign": speech-split.ts  (people ↔ items, share counts)
                      mode "bill":   speech-bill.ts   (items, prices, charges, total; + who, via speech-split)
                      ▼
          review screen (same one a photo scan uses) ──Confirm──▶ normal create-bill API
```

- Name matching by sound: `speech-names.ts` (consonant skeleton + edit distance, same first sound, 4+ letters, exact beats fuzzy).
- Audio is read in memory and discarded; only the text is returned. Nothing is stored.
- Model: `STT_MODEL` (default `base.en`) and `STT_MODELS_DIR` (default `/models`) in `deploy/pi/stt/server.py`. int8, 3 threads, beam 1, temperature 0, VAD on, no retries.

## 5. Prove it works on your Pi

1. **Machine checks** (no audio needed):
   ```bash
   npm run check && npm test && npm test --workspace=server     # all unit tests
   cd server && npx vitest run --config vitest.config.ts src/lib/speech     # just the matcher + bill parser
   ```
2. **Speed**: record a 10 s clip on a phone and time it. The D4.9 measurement on the Pi was the basis for choosing `base.en`; if a 10 s clip takes more than about 10 s end to end, drop to `tiny.en` by setting `STT_MODEL` and rebuilding.
3. **By hand on a phone**, each of these, with real voices at a real table (this is the test that counts; the Mac tests used synthetic voices):
   - Speak the bill (section A) and Confirm. Check the saved bill's items and total.
   - Say who had it inline (section B), starting from a group page, then again with **no group chosen** (two groups) to see the note and the fill-in after choosing.
   - Assign by voice whole-bill and per item (C, D) on a scanned receipt.
   - Say something it must refuse ("Karan didn't have the naan"): nothing assigned, reason shown.
   - Stop the stt container (`docker compose stop stt`), reload: mics vanish, everything still works by typing. Start it again.
4. Report in `docs/PI-STATUS.md` what was heard vs what was assigned, especially names Whisper got wrong. That list drives whether nicknames or a bigger model are worth it.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| No mic icons | `docker compose ps` stt unhealthy; or page isn't HTTPS; or `/api/speech/status` is `false` |
| Mic icon, but "Couldn't start the microphone" | Browser permission denied; allow it for the site |
| First recording after a restart is slow | Model is loading; later ones are faster |
| Names heard wrong | Check the name is in the group (the prompt is built from the group's members); a name Whisper keeps mangling is the nickname case, which is not built |
| An item left blank with "could be more than one item" | Two items share a word ("Butter Naan", "Butter Chicken"): say more of the name |
| stt container killed | 1500 MB cap hit; look at `docker compose logs stt` and `docker stats` |

## 7. Not built (on purpose)

Nicknames (needs a migration), tap-to-choose between two similar names (it explains in words instead), languages other than English (`base.en`), wake words or hands-free. Ideas go in `BACKLOG.md`, not into this phase.
