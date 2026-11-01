// Plan D4.7: test sentences for working out a split from speech. Written before the matcher.
// "dev" sentences may be used to tune it. "heldOut" sentences must not be: they're what tells us
// how it does on sentences it wasn't tuned for. Everything here is made up.
//
// Sentences are lowercase with no punctuation, because that's how speech recognition returns them.
// `expected` maps item number -> member id -> units. Equal shares are 1 each. An item left out
// must stay unassigned, because a blank is safe and a wrong guess isn't.

export const EVAL_ITEMS = [
  { index: 0, name: "Paneer Butter Masala", quantity: 2 },
  { index: 1, name: "Butter Naan", quantity: 4 },
  { index: 2, name: "Veg Biryani", quantity: 1 },
  { index: 3, name: "Masala Chaas", quantity: 3 },
  { index: 4, name: "Gulab Jamun", quantity: 2 },
  { index: 5, name: "Fresh Lime Soda", quantity: 1 },
];

/** Asha is the person speaking. */
export const EVAL_MEMBERS = [
  { id: 1, name: "Asha", isSpeaker: true },
  { id: 2, name: "Ravi" },
  { id: 3, name: "Karan" },
  { id: 4, name: "Priya" },
];

const EVERYONE = { 1: 1, 2: 1, 3: 1, 4: 1 };

export interface EvalCase {
  text: string;
  expected: Record<number, Record<number, number>>;
}

export const DEV_CASES: EvalCase[] = [
  { text: "karan had the naan", expected: { 1: { 3: 1 } } },
  { text: "priya and i shared the biryani", expected: { 2: { 1: 1, 4: 1 } } },
  { text: "ravi had the paneer butter masala and karan had the biryani", expected: { 0: { 2: 1 }, 2: { 3: 1 } } },
  { text: "everyone shared the biryani", expected: { 2: EVERYONE } },
  { text: "everyone except karan shares the chaas", expected: { 3: { 1: 1, 2: 1, 4: 1 } } },
  { text: "give the biryani to ravi and split the chaas between me and priya", expected: { 2: { 2: 1 }, 3: { 1: 1, 4: 1 } } },
  { text: "biryani ravi ko do chaas main aur priya mein baant do", expected: { 2: { 2: 1 }, 3: { 1: 1, 4: 1 } } },
  { text: "two naans for me two for priya", expected: { 1: { 1: 2, 4: 2 } } },
  { text: "i had the gulab jamun", expected: { 4: { 1: 1 } } },
  { text: "sabne biryani khaya", expected: { 2: EVERYONE } },
  { text: "karan ko chhod ke sabne chaas pi", expected: { 3: { 1: 1, 2: 1, 4: 1 } } },
  { text: "ravi ne paneer liya aur priya ne soda liya", expected: { 0: { 2: 1 }, 5: { 4: 1 } } },
  { text: "i had the soda and everything else was shared", expected: { 5: { 1: 1 }, 0: EVERYONE, 1: EVERYONE, 2: EVERYONE, 3: EVERYONE, 4: EVERYONE } },
  { text: "asha and ravi split the lime soda", expected: { 5: { 1: 1, 2: 1 } } },
  { text: "the biryani was for rabi", expected: { 2: { 2: 1 } } },
  { text: "ravi paid for the biryani", expected: {} },
  { text: "karan didn't have the naan", expected: {} },
  { text: "ravi had the butter one", expected: {} },
  { text: "three chaas one for each of ravi karan and priya", expected: { 3: { 2: 1, 3: 1, 4: 1 } } },
  { text: "we all shared the naan except ravi", expected: { 1: { 1: 1, 3: 1, 4: 1 } } },
];

export const HELD_OUT_CASES: EvalCase[] = [
  { text: "priya had the jamun", expected: { 4: { 4: 1 } } },
  { text: "ravi and karan shared the masala chaas", expected: { 3: { 2: 1, 3: 1 } } },
  { text: "the naan is for karan and the soda is for me", expected: { 1: { 3: 1 }, 5: { 1: 1 } } },
  { text: "all of us had the paneer", expected: { 0: EVERYONE } },
  { text: "everyone but priya had the biryani", expected: { 2: { 1: 1, 2: 1, 3: 1 } } },
  { text: "paneer priya ko aur biryani karan ko do", expected: { 0: { 4: 1 }, 2: { 3: 1 } } },
  { text: "mera naan aur ravi ka soda", expected: { 1: { 1: 1 }, 5: { 2: 1 } } },
  { text: "one naan for ravi and three for karan", expected: { 1: { 2: 1, 3: 3 } } },
  { text: "gulab jamun sabke liye", expected: { 4: EVERYONE } },
  { text: "ravi ke alawa sab ne naan khaya", expected: { 1: { 1: 1, 3: 1, 4: 1 } } },
  { text: "split the biryani between karan and priya and i had the soda", expected: { 2: { 3: 1, 4: 1 }, 5: { 1: 1 } } },
  { text: "karan had the biryani and the chaas", expected: { 2: { 3: 1 }, 3: { 3: 1 } } },
  { text: "i had paneer butter masala ravi had biryani karan had soda", expected: { 0: { 1: 1 }, 2: { 2: 1 }, 5: { 3: 1 } } },
  { text: "karan had the naan and the rest is for priya", expected: { 1: { 3: 1 }, 0: { 4: 1 }, 2: { 4: 1 }, 3: { 4: 1 }, 4: { 4: 1 }, 5: { 4: 1 } } },
  { text: "pria had the soda", expected: { 5: { 4: 1 } } },
  { text: "maybe ravi had the chaas i am not sure", expected: {} },
  { text: "ravi did not eat the biryani", expected: {} },
  { text: "two jamun for karan", expected: { 4: { 3: 2 } } },
  { text: "the sweet dish was for priya", expected: {} },
  { text: "we shared the naan", expected: {} },
];

/** Harder, more casual phrasing, written to find where rules break. */
export const STRESS_CASES: EvalCase[] = [
  { text: "ravi had the naan but karan had the soda", expected: { 1: { 2: 1 }, 5: { 3: 1 } } },
  { text: "karan and priya had one naan each and ravi had two", expected: { 1: { 2: 2, 3: 1, 4: 1 } } },
  { text: "i'll take the biryani", expected: { 2: { 1: 1 } } },
  { text: "the paneer was mine", expected: { 0: { 1: 1 } } },
  { text: "ravi had half the biryani and karan the other half", expected: { 2: { 2: 1, 3: 1 } } },
  { text: "karan had the biryani ravi too", expected: { 2: { 2: 1, 3: 1 } } },
  { text: "ravi had the naan same for priya", expected: { 1: { 2: 1, 4: 1 } } },
  { text: "everyone had chaas except me", expected: { 3: { 2: 1, 3: 1, 4: 1 } } },
  { text: "karan had two chaas and ravi had one", expected: { 3: { 2: 1, 3: 2 } } },
  { text: "give ravi the naan", expected: { 1: { 2: 1 } } },
  { text: "the naan and the biryani were shared between ravi and karan", expected: { 1: { 2: 1, 3: 1 }, 2: { 2: 1, 3: 1 } } },
  { text: "ravi's naan and karan's soda", expected: { 1: { 2: 1 }, 5: { 3: 1 } } },
  { text: "paneer for everyone except karan and priya", expected: { 0: { 1: 1, 2: 1 } } },
  { text: "chaas for ravi and karan and the jamun for everyone", expected: { 3: { 2: 1, 3: 1 }, 4: EVERYONE } },
  { text: "the drinks were for ravi", expected: {} },
  { text: "all the naan went to karan", expected: { 1: { 3: 1 } } },
  { text: "everything was shared", expected: { 0: EVERYONE, 1: EVERYONE, 2: EVERYONE, 3: EVERYONE, 4: EVERYONE, 5: EVERYONE } },
  { text: "ravi had everything except the soda", expected: { 0: { 2: 1 }, 1: { 2: 1 }, 2: { 2: 1 }, 3: { 2: 1 }, 4: { 2: 1 } } },
  { text: "split it between ravi and karan", expected: {} },
  { text: "karan had one naan", expected: {} },
  { text: "no one had the soda", expected: {} },
  { text: "only asha and priya had jamun", expected: { 4: { 1: 1, 4: 1 } } },
  { text: "priya had the chaas and so did ravi", expected: { 3: { 2: 1, 4: 1 } } },
  { text: "biryani main ne khaya", expected: { 2: { 1: 1 } } },
  { text: "naan ravi aur karan ka hai", expected: { 1: { 2: 1, 3: 1 } } },
  { text: "soda kisi ne nahi piya", expected: {} },
  { text: "priya ne naan aur paneer dono liya", expected: { 0: { 4: 1 }, 1: { 4: 1 } } },
  { text: "ravi wanted the biryani but karan ate it", expected: {} },
  { text: "karan had the soda actually no ravi had it", expected: { 5: { 2: 1 } } },
  { text: "asha paid and everyone shared the biryani", expected: { 2: EVERYONE } },
];
