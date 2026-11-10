# Nabz: a voice agent that turns dealer phone calls into a weekly demand index

## The problem
Demand in India's offline economy moves at the shop counter, and the only people who see it are the dealers. Enquiries, bookings, stock and discounts show up in official numbers weeks later, and makers count what they ship, not what sells. A short weekly phone call in the dealer's own language gets answers a form never will, but running those calls by hand does not scale.

## What I built
Nabz is a voice agent that calls vehicle dealers, asks six short questions, and turns the answers into a weekly 0–100 demand index by brand and state.

The agent speaks and listens with **Gnani's models**:
- **Gnani Prisma (`prisma-v3.0`, speech to text)** hears the dealer. It handles noisy phone-quality audio and Hindi mixed with English, which is how dealers actually talk.
- **Gnani Timbre (`timbre-v2.5`, text to speech)** speaks every question aloud in Hindi or English, and voices the simulated dealers in Hinglish for testing.

Claude runs the conversation (Haiku 5.5) and reads the finished transcript into typed answers (Sonnet 5.5). The agent asks the questions straight from the survey definition, so what it asks is exactly what the index scores. It says it is an AI in its first line, accepts "I don't know" without pushing, and never makes up an answer: a gap is recorded with its reason (didn't know, declined, not asked).

A finished call goes through the same checks as any other: quality rules, then the index engine, then the Weekly Pulse and Brand × state pages. Clients never see a dealer's name or number, and any cell with fewer than 3 dealers is hidden.

## Who it is for
- **Funds and analysts** who want a leading read on consumer demand before results day.
- **Manufacturers and suppliers** who need to know what is actually selling by brand and state.
- **Dealers**, who are meant to get a weekly read of their own area back (a concept, not built yet).

## How I tested it
All data is synthetic. No real phone number was dialled and no real recording was used.

I generated 80 complete calls (40 made-up dealers over two weeks, 8 brand × state cells). For each call, a Claude-played dealer was given known answers. Its lines were spoken by Timbre, mixed with line noise at 4% of full scale, and transcribed by Prisma before the agent responded. Then I checked what the finished call recorded against what the dealer was told to say:

- **471 of 480 answers matched (98.1%).**
- Questions the dealer was told they did not know were correctly recorded as "didn't know", not guessed.
- The results fill the live pages: a Demand index of 56.6 from 40 dealers, and a brand × state heatmap with a real spread (from 35 to 72).

## Cost
The whole build and test run used about $0.79 of Claude and about 160 of the 5,000 programme credits (a padded estimate). A full call costs roughly one US cent plus 2 credits. Spend is capped in code: every Gnani and Claude request checks the cap first and refuses to send if it would pass it.

## Honest limits
- The agent runs in a browser session, not over the phone network, so there is no real telephony yet.
- Accuracy is measured against synthetic dealers with known answers. Real dealers will be harder, and that needs a real pilot.
- Claude does the reasoning because Gnani's language model is not on the API platform yet. Gnani handles all speech in and out.

## Gnani models and APIs used
- Prisma `prisma-v3.0`, REST speech-to-text (`POST /stt/v3`), Hindi (`hi-IN`)
- Timbre `timbre-v2.5`, REST text-to-speech (`POST /api/v1/tts/inference`), Hindi, English and Hinglish voices

## Contributions
<!-- Fill in each team member's contribution. -->
- [Name]: …
