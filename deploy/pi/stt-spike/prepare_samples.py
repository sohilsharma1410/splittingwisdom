"""Builds the speech test clips. Run this on a computer, then copy the result to the Pi.
The clips are never stored in this repo.

    python prepare_samples.py <common voice parquet> <piper voices dir> <output dir>

Needs: pyarrow, numpy, av, piper-tts.

Sets:
- real:       real Indian-accented speakers reading general sentences. Common Voice, CC0
              (huggingface.co/datasets/ishands/commonvoice-indian_accent, part 0000).
- real-long:  several clips from one speaker joined, because people will talk for longer.
- real-noisy: real clips with other people's speech mixed in, like a busy restaurant.
- split:      made-up split sentences from a text-to-speech voice. No public recording of
              this exists. English written in Devanagari makes the Hindi voices sound Indian
              and say the names and dishes properly, but these are still SYNTHETIC.
- split-long: longer made-up descriptions of a whole bill. Also synthetic.
- split-noisy: split-long with the same background speech.
- empty:      near silence and background speech only, which must produce no text.

Split clips are stored the way phones record: WebM/Opus for Android, MP4/AAC for iPhone.
"""
import io
import json
import random
import re
import sys
import wave
from pathlib import Path

import av
import numpy as np
import pyarrow.parquet as pq
from piper import PiperVoice

SEED = 20261101
RATE = 16000
REAL_CLIPS = 60
LONG_CLIPS = 6
LONG_SECONDS = 25
NOISY_CLIPS = 20
SNR_DB = 10
BABBLE_SPEAKERS = 12
INDIAN = re.compile(r"india|south asia", re.I)
OTHER_ACCENT = re.compile(r"united states|england|scottish|malaysia|canad|austral", re.I)
FOOD_WORDS = re.compile(r"\b(rice|chicken|pizza|coffee|tea|soup|bread|dinner|shared|split|paid|bill|restaurant)\b", re.I)

# Voice, then the format that voice's clips are stored in.
VOICES = [
    ("hi_IN-priyamvada-medium", "webm"),
    ("hi_IN-rohan-medium", "mp4"),
    ("en_US-lessac-medium", "webm"),
]

# Who the clips talk about. The app knows these when someone speaks, so it can prompt with them.
PROMPT = "Asha, Ravi, Karan, Priya. Paneer Butter Masala, Butter Naan, Veg Biryani, Masala Chaas, Gulab Jamun, Fresh Lime Soda."
KEYWORDS = {"asha", "ravi", "karan", "priya", "paneer", "butter", "masala", "naan", "naans", "veg", "biryani", "chaas", "gulab", "jamun", "lime", "soda"}

# The English cases from server/src/lib/speech-split.eval-data.ts, whose expected answers live there.
SENTENCES = [
    "karan had the naan",
    "priya and i shared the biryani",
    "ravi had the paneer butter masala and karan had the biryani",
    "everyone shared the biryani",
    "everyone except karan shares the chaas",
    "give the biryani to ravi and split the chaas between me and priya",
    "two naans for me two for priya",
    "i had the gulab jamun",
    "i had the soda and everything else was shared",
    "asha and ravi split the lime soda",
    "ravi paid for the biryani",
    "karan didn't have the naan",
    "ravi had the butter one",
    "three chaas one for each of ravi karan and priya",
    "we all shared the naan except ravi",
    "priya had the jamun",
    "ravi and karan shared the masala chaas",
    "the naan is for karan and the soda is for me",
    "all of us had the paneer",
    "everyone but priya had the biryani",
    "one naan for ravi and three for karan",
    "split the biryani between karan and priya and i had the soda",
    "karan had the biryani and the chaas",
    "i had paneer butter masala ravi had biryani karan had soda",
    "karan had the naan and the rest is for priya",
    "maybe ravi had the chaas i am not sure",
    "ravi did not eat the biryani",
    "two jamun for karan",
    "the sweet dish was for priya",
    "we shared the naan",
    "ravi had the naan but karan had the soda",
    "karan and priya had one naan each and ravi had two",
    "i'll take the biryani",
    "the paneer was mine",
    "ravi had half the biryani and karan the other half",
    "karan had the biryani ravi too",
    "ravi had the naan same for priya",
    "everyone had chaas except me",
    "karan had two chaas and ravi had one",
    "give ravi the naan",
    "the naan and the biryani were shared between ravi and karan",
    "ravi's naan and karan's soda",
    "paneer for everyone except karan and priya",
    "chaas for ravi and karan and the jamun for everyone",
    "the drinks were for ravi",
    "all the naan went to karan",
    "everything was shared",
    "ravi had everything except the soda",
    "split it between ravi and karan",
    "karan had one naan",
    "no one had the soda",
    "only asha and priya had jamun",
    "priya had the chaas and so did ravi",
    "ravi wanted the biryani but karan ate it",
    "karan had the soda actually no ravi had it",
    "asha paid and everyone shared the biryani",
]

LONG_SENTENCES = [
    "so ravi had the paneer butter masala karan had the veg biryani priya and i shared the butter naan and everyone shared the gulab jamun",
    "the biryani was for karan and ravi the chaas was shared between priya and me and ravi had the fresh lime soda",
    "i had the naan and the paneer priya had the biryani and everyone except ravi shared the jamun",
    "karan and priya split the biryani ravi had the soda and everything else was shared",
]

# How each word is spoken by the Hindi voices.
DEVANAGARI = {
    "a": "अ", "actually": "ऐक्चुअली", "all": "ऑल", "am": "ऐम", "and": "ऐंड", "asha": "आशा", "ate": "एट", "between": "बिटवीन",
    "biryani": "बिरयानी", "but": "बट", "butter": "बटर", "chaas": "छास", "didn't": "डिडन्ट", "did": "डिड", "dish": "डिश",
    "drinks": "ड्रिंक्स", "each": "ईच", "eat": "ईट", "else": "एल्स", "everyone": "एवरीवन", "everything": "एवरीथिंग",
    "except": "एक्सेप्ट", "for": "फॉर", "fresh": "फ्रेश", "give": "गिव", "gulab": "गुलाब", "had": "हैड", "half": "हाफ",
    "have": "हैव", "i": "आई", "i'll": "आईल", "is": "इज़", "it": "इट", "jamun": "जामुन", "karan": "करन", "karan's": "करन्स",
    "lime": "लाइम", "masala": "मसाला", "maybe": "मेबी", "me": "मी", "mine": "माइन", "naan": "नान", "naans": "नान्स",
    "no": "नो", "not": "नॉट", "of": "ऑफ", "one": "वन", "only": "ओनली", "other": "अदर", "paid": "पेड", "paneer": "पनीर",
    "priya": "प्रिया", "ravi": "रवि", "ravi's": "रविज़", "rest": "रेस्ट", "same": "सेम", "shared": "शेयर्ड", "shares": "शेयर्स",
    "so": "सो", "soda": "सोडा", "split": "स्प्लिट", "sure": "श्योर", "sweet": "स्वीट", "take": "टेक", "the": "द", "three": "थ्री",
    "to": "टू", "too": "टू", "two": "टू", "us": "अस", "veg": "वेज", "wanted": "वॉन्टेड", "was": "वॉज़", "we": "वी", "went": "वेंट",
    "were": "वर", "by": "बाई",
}


def spoken_text(sentence, voice):
    if voice.startswith("en_"):
        return sentence
    return " ".join(DEVANAGARI[word] for word in sentence.split())


def to_pcm(data=None, path=None):
    """Decodes any audio to mono 16 kHz floats."""
    with av.open(io.BytesIO(data) if data is not None else str(path)) as container:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        parts = []
        for frame in container.decode(audio=0):
            parts.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(frame))
    return np.concatenate(parts).astype(np.float32)


def speak(voice, text):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        voice.synthesize_wav(text, out)
    return to_pcm(buffer.getvalue())


def save(pcm, path, kind):
    """Encodes as a phone would: Opus in WebM (Android) or AAC in MP4 (iPhone)."""
    codec, sample_rate, bit_rate = {"webm": ("libopus", 48000, 32000), "mp4": ("aac", 44100, 64000)}[kind]
    pcm = np.clip(pcm, -1, 1)
    with av.open(str(path), "w") as out:
        stream = out.add_stream(codec, rate=sample_rate)
        stream.bit_rate = bit_rate
        stream.layout = "mono"
        frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1), format="flt", layout="mono")
        frame.sample_rate = RATE
        resampler = av.AudioResampler(format=stream.codec_context.format.name, layout="mono", rate=sample_rate)
        for resampled in resampler.resample(frame) + resampler.resample(None):
            for packet in stream.encode(resampled):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)


def looped(pcm, length):
    return np.tile(pcm, length // len(pcm) + 1)[:length]


def with_background(speech, babble, rng):
    start = rng.randrange(len(babble) - len(speech))
    noise = babble[start : start + len(speech)]
    gain = np.sqrt(np.mean(speech**2) / (np.mean(noise**2) * 10 ** (SNR_DB / 10)))
    return speech + noise * gain


def normalised(text):
    return re.sub(r"[^a-z' ]", "", text.lower().replace("’", "'")).split()


def main():
    parquet, voices_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    clips_dir = out_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    answers = {}

    columns = ["client_id", "sentence", "accents", "duration_ms", "up_votes", "down_votes", "gender", "audio"]
    rows = [
        row
        for row in pq.ParquetFile(parquet).read(columns=columns).to_pylist()
        if row["accents"] and INDIAN.search(row["accents"]) and not OTHER_ACCENT.search(row["accents"])
        and row["up_votes"] >= 2 and row["down_votes"] == 0 and 3000 <= row["duration_ms"] <= 12000
    ]
    rng.shuffle(rows)

    by_speaker = {}
    for row in rows:
        by_speaker.setdefault(row["client_id"], []).append(row)

    # One clip per speaker, half labelled female, and some about food or money.
    used_speakers, picked = set(), []

    def pick(matches, count):
        taken = 0
        for row in rows:
            if taken == count:
                return
            if row["client_id"] not in used_speakers and matches(row):
                used_speakers.add(row["client_id"])
                picked.append(row)
                taken += 1

    half = REAL_CLIPS // 2
    pick(lambda r: r["gender"] == "female_feminine" and FOOD_WORDS.search(r["sentence"]), 8)
    pick(lambda r: r["gender"] == "female_feminine", half - len(picked))
    pick(lambda r: r["gender"] == "male_masculine" and FOOD_WORDS.search(r["sentence"]), 8)
    pick(lambda r: r["gender"] == "male_masculine", REAL_CLIPS - len(picked))

    for number, row in enumerate(picked):
        name = f"real-{number:03d}.mp3"
        (clips_dir / name).write_bytes(row["audio"]["bytes"])
        answers[name] = {"set": "real", "text": row["sentence"], "prompt": False}

    # Background speech comes from speakers the clips don't use.
    spare = [row for row in rows if row["client_id"] not in used_speakers]
    seen, babble_rows = set(), []
    for row in spare:
        if row["client_id"] not in seen:
            seen.add(row["client_id"])
            babble_rows.append(row)
        if len(babble_rows) == BABBLE_SPEAKERS:
            break
    babble_pcm = [to_pcm(row["audio"]["bytes"]) for row in babble_rows]
    used_speakers |= seen
    babble_length = RATE * 120
    babble = sum(looped(pcm / (np.abs(pcm).max() + 1e-6), babble_length) for pcm in babble_pcm).astype(np.float32)

    for number, row in enumerate(picked[:: REAL_CLIPS // NOISY_CLIPS][:NOISY_CLIPS]):
        name = f"real-noisy-{number:03d}.webm"
        save(with_background(to_pcm(row["audio"]["bytes"]), babble, rng), clips_dir / name, "webm")
        answers[name] = {"set": "real-noisy", "text": row["sentence"], "prompt": False}

    # Several clips from one speaker, to time longer recordings.
    speakers = [rows_ for speaker, rows_ in by_speaker.items() if speaker not in used_speakers and sum(r["duration_ms"] for r in rows_) >= LONG_SECONDS * 1000]
    for number, clips in enumerate(speakers[:LONG_CLIPS]):
        joined, text, seconds = [], [], 0
        for row in clips:
            if seconds >= LONG_SECONDS:
                break
            pcm = to_pcm(row["audio"]["bytes"])
            joined += [pcm, np.zeros(RATE // 3, dtype=np.float32)]
            text.append(row["sentence"])
            seconds += len(pcm) / RATE
        name = f"real-long-{number:03d}.webm"
        save(np.concatenate(joined), clips_dir / name, "webm")
        answers[name] = {"set": "real-long", "text": " ".join(text), "prompt": False}

    # Made-up split sentences.
    for voice_name, kind in VOICES:
        voice = PiperVoice.load(str(voices_dir / f"{voice_name}.onnx"))
        short_name = voice_name.split("-")[1]
        for number, sentence in enumerate(SENTENCES):
            name = f"split-{short_name}-{number:03d}.{kind}"
            save(speak(voice, spoken_text(sentence, voice_name)), clips_dir / name, kind)
            answers[name] = {"set": "split", "text": sentence, "prompt": True, "voice": short_name}
        for number, sentence in enumerate(LONG_SENTENCES):
            pcm = speak(voice, spoken_text(sentence, voice_name))
            name = f"split-long-{short_name}-{number:03d}.{kind}"
            save(pcm, clips_dir / name, kind)
            answers[name] = {"set": "split-long", "text": sentence, "prompt": True, "voice": short_name}
            name = f"split-noisy-{short_name}-{number:03d}.{kind}"
            save(with_background(pcm, babble, rng), clips_dir / name, kind)
            answers[name] = {"set": "split-noisy", "text": sentence, "prompt": True, "voice": short_name}

    # Nothing was said, so these must come back empty.
    quiet = np.random.default_rng(SEED).normal(0, 0.0005, RATE * 8).astype(np.float32)
    save(quiet, clips_dir / "empty-silence.webm", "webm")
    save(quiet, clips_dir / "empty-silence.mp4", "mp4")
    save(babble[: RATE * 8] / (np.abs(babble[: RATE * 8]).max() + 1e-6) * 0.2, clips_dir / "empty-background.webm", "webm")
    for name in ("empty-silence.webm", "empty-silence.mp4", "empty-background.webm"):
        answers[name] = {"set": "empty", "text": "", "prompt": True}

    answers = {"prompt": PROMPT, "keywords": sorted(KEYWORDS), "clips": answers}
    (out_dir / "answers.json").write_text(json.dumps(answers, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Prepared {len(answers['clips'])} clips in {clips_dir}")


if __name__ == "__main__":
    main()
