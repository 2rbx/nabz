# Nabz: a voice agent that tunes into Bharat's economy

**One line:** Nabz calls dealers in their own language, asks six short questions, and turns the answers into a weekly 0–100 demand index by brand and state.

## The problem
Demand moves at the shop counter, and only the dealer sees it. Official numbers arrive weeks later, and makers count what they ship, not what sells. A 90-second weekly call in the dealer's language gets answers a form never will, but doing those calls by hand does not scale.

## The solution
A voice agent built on **Gnani's models**:
- **Prisma** (speech to text) hears the dealer, through noisy phone audio and Hindi mixed with English.
- **Timbre** (text to speech) speaks each question in Hindi or English.
- **Claude** runs the conversation and reads the transcript into typed answers.

The agent says it is an AI, asks exactly what the index scores, accepts "I don't know" without pushing, and never invents an answer. Calls are checked, scored, and shown on a Weekly Pulse and a Brand × state heatmap. Clients never see a dealer's name or number, and cells with fewer than 3 dealers are hidden.

## Who it is for
Funds and analysts who want a leading read on demand, manufacturers and suppliers who need to know what actually sells, and dealers, who would get a weekly read of their own area back.

## Proof
All data is synthetic: no real number was dialled and no real recording used. In 80 complete calls (40 made-up dealers, two weeks, 8 brand × state cells) with Timbre-voiced dealers, 4% line noise and Prisma transcription, **471 of 480 answers (98.1%) matched what each dealer was told to say.** The whole run cost about $0.79 of Claude and about 160 of 5,000 programme credits, with both spend caps enforced in code.

## Honest limits
The agent runs in a browser session, not on the phone network. Accuracy is measured on synthetic dealers, so real dealers need a pilot. Claude does the reasoning because Gnani's language model is not on the API yet.

## Try it
`pnpm dev`, then Ops → Voice agent. See `README.md` for setup and `docs/gnani-entry.md` for the full write-up.
