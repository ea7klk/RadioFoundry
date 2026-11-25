<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 The RadioFoundry Authors -->

# Building a codeplug from where you operate

The **Builder** tab fills a codeplug from a location: standard analog channels,
the DMR repeater you can hear, the talkgroups you use, and analog repeaters.

**Every tick changes the codeplug immediately.** Tick a repeater and its channel,
contacts and RX group list appear in their tabs at once; tick a pack and its
channels are there. **Every tick is its own step**, so *Undo* takes back exactly
that one — the repeater you just added, or the pack, not the whole session.
Unticking a box removes what that tick added and keeps anything else still using
the same contact or zone.

Everything happens in the page. Your choices are kept in this browser only.

## 1. Your location

Any of four ways, and they all end up as a latitude and longitude:

- **Latitude and longitude**, then *Use coordinates*.
- A **Maidenhead locator** (four, six or eight characters, such as `IM76SR`),
  then *Use locator*. The centre of the square is used.
- **Use my location**: the browser asks for permission once.
- **Nearby city**: type a name and press *Find*. The place search is
  OpenStreetMap's Nominatim, called from your browser and cached for 30 days.
  Picking a result also sets the country, and so the IARU region.

The APRS position and every distance come from this point.

## 2. Standard analog channels

Channel packs are fixed frequency lists: IARU calling and simplex frequencies,
APRS, PMR446, FRS/GMRS, marine VHF and NOAA weather. The **country** picks the
IARU region and the APRS frequency; the region can be overridden, and packs from
another region are marked *other region* rather than hidden.

**Add an APRS position** writes a fixed position at your location, as a
six-character locator on the region's usual frequency, and links it to that APRS
channel as its revert channel. The SSID is yours to choose (7 by default).

## 3. Nearby DMR repeaters

Every repeater in the snapshot within the radius, nearest first, with its
receive and transmit frequencies, colour code and distance. Ticking one adds:

- one **channel**, receive on the repeater's output and transmit on its input;
- one **contact per static talkgroup**, carrying the timeslot override
  Brandmeister publishes for that talkgroup at that repeater;
- one **RX group list** holding them all, so the talkgroups can be selected on
  the radio without editing the contact.

**Default contact.** The first static talkgroup Brandmeister lists for the
repeater becomes the channel's default contact.

**Repeaters without a published list.** Brandmeister has no bulk endpoint for
per-repeater talkgroups, and it throttles the one that exists. Where the
snapshot has no list for a repeater, the Builder uses that repeater's *national*
talkgroup instead, read from the same id prefix: repeater `214702` is in Spain,
talkgroup `214` is Spain. The row says `TG 214 Spain (national)` so you can tell
the difference. Where the table has no such talkgroup either, *Use TG 9 (Local)*
applies.

## 4. DMR contacts

The whole Brandmeister talkgroup list — 1,848 talkgroups — in a table you can
search and tick several rows of.

- **By name or number**: `Málaga`, `Spain`, `214`, `JOTA`.
- **By continent**: Worldwide, Europe, North America and the Caribbean, South
  America, Asia and the Middle East, Africa, Oceania.
- **By country**: 122 countries, found from the talkgroup id's ITU prefix
  (`214` Spain, `262` Germany), not guessed from the name.
- **Other**: talkgroups with no identifiable place — `Local`, `Cluster`,
  `Radio Test`, `Parrot`, language nets, interest groups and events.

The country list and the counts follow the search. Ticked rows become plain
group-call contacts with no timeslot override, so they work on any DMR channel.
A talkgroup a repeater already brought in is not duplicated; when the repeater's
contact pins a slot, the two are named `Spain` and `Spain TS1` so you can tell
them apart.

## 5. Nearby analog repeaters

Both bands, from the committed snapshot: URE's Spanish list and HearHam
elsewhere, merged on callsign and output frequency with URE's record kept where
both describe a repeater. **Band** narrows to VHF (below 300 MHz) or UHF.

Entries come with the repeater's shift and its CTCSS/DCS tone. Where a tone is
missing it says *no tone*: set the one you need in the channel afterwards. The
Builder tells you how many entries in your build have no tone.

**Your own list.** A CSV or JSON file of repeaters — a national coordinator's
export, a club list, a RepeaterBook export you are entitled to use. It is read in
the browser and never uploaded. Columns are matched loosely:

```csv
Callsign,Output,Offset,CTCSS,Latitude,Longitude,City,Mode
ED7YAA,145.775,-0.6,82.5,36.79,-4.48,Malaga,FM
```

`output`/`frequency`, `offset`/`shift` (MHz, kHz or Hz), `tx`/`uplink_mhz` for an
explicit input, `tone`/`ctcss`/`encode`, `lat`, `lon`, `city`, `mode`. Rows
without coordinates are kept but never match a radius.

## 6. DMR simplex

The Spanish national simplex agreement (URE / Radio Club Fene), which follows
the IARU Region 1 band plan and fixes both the frequencies and the channel
names, so two stations can agree a QSY by name:

| Channel | MHz | Use |
|---|---|---|
| CQDVHF | 145.375 | VHF calling |
| S1-VHF | 145.3875 | VHF QSO 1 |
| S2-VHF | 145.400 | VHF QSO 2 |
| SOTA-V | 144.900 | VHF SOTA |
| CQDUHF | 433.450 | UHF calling |
| S1-UHF | 433.775 | UHF QSO 1 |
| S2-UHF | 438.025 | UHF QSO 2 |
| S3-UHF | 438.0375 | UHF QSO 3 |
| SOTA-U | 438.050 | UHF SOTA |

All on colour code 1, slot 1, talkaround. The contact is your choice:

- **TG 99** — a group call to 99, the talkgroup the plan names;
- **AllCall (16777215)** — reaches every DMR radio in range;
- **Both** — two channels per frequency, because a channel holds one contact.
  The contact is appended to the name (`CQDVHF TG99`, `CQDVHF ALL`), so the
  channel list shows which is which.

**Access points** are optional: PA1-V…PA6-U on 144.8125–144.875 and
430.400–439.825, slot 2, in their own zone.

## 7. Station

The callsign becomes the radio name and the APRS source, and the DMR ID goes into
the codeplug's radio settings — **but only where those fields are still empty**.
A name or ID already in the codeplug is never overwritten; the panel says so.

## Before you write it to the radio

Two things the tab asks of you, because the Builder cannot know them:

**Set the power on each channel.** Everything it adds starts at the radio's
default power. Go through the channels and set each to the **least power that
does the job** — a local simplex channel rarely needs more than low, a repeater
30 km away may need high. Stay inside what your licence allows and what the
service allows: PMR446 is 0.5 W ERP, FRS is 2 W on most channels and 0.5 W on
8–14, a marine handheld is usually 1 W on low. An access point or hotspot mode
should not run above 5–10 W.

**Review the zones.** They are grouped by kind (`DMR`, `DMR SIMPLEX`,
`DMR ACCESS`, `ANALOG`, `STANDARD`, `APRS`) and split past 80 channels per zone.
That is a starting point, not a plan: drop channels you will never use, move the
ones you use together into one zone, and order them so the ones you reach for
come first.

## What each tick does

| Tick | Adds, at once |
|---|---|
| A DMR repeater | one channel, one contact per static talkgroup, one RX group list |
| A channel pack | its channels, in the `STANDARD` zone (an APRS pack also adds the position if one is set) |
| A talkgroup row | one group-call contact, no timeslot override |
| An analog repeater | one FM channel with its shift and tone, in `ANALOG` |
| The simplex box | its channels and the TG 99 / AllCall contacts; the three buttons switch the contact |
| The APRS box | the fixed position and its link to the APRS channel |

Each of those is one line in the change history, so Undo moves one tick at a
time. Unticking removes exactly that tick's records: a contact another channel
still uses stays, and a zone another source filled stays.

**Remove everything the Builder added** takes all of it out in one change.

Warnings — a name shortened to the radio's 16 characters, a talkgroup list cut
at 32 entries, a repeater with no tone — appear under the tab as the tick
happens. A tick that would overflow a table (1024 channels, 68 zones) is refused
before it changes anything, with a line saying which table is full.

The **Channels**, **Contacts** and **Zones** tabs show the records as they
arrive, **Problems** validates them, and **Save** or **Write to Radio** sends the
codeplug on.

## Where the data comes from

The repeater and talkgroup lists are snapshots committed with the site, because
Brandmeister and HearHam send no CORS headers and a page cannot read them
directly. `.github/workflows/builder-data.yml` refreshes them weekly and commits
the result; `site/rfoundrysite/builder_data.py` does the work and can be run by
hand:

```sh
python3 site/rfoundrysite/builder_data.py                   # everything
python3 site/rfoundrysite/builder_data.py --only talkgroups  # just the talkgroups
python3 site/rfoundrysite/builder_data.py --offline          # from build/builder-cache/
```

The dates of the current snapshots are shown under the DMR repeater list.
