// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Copyright (c) 2026 The RadioFoundry-cp-builder Authors
// What the Builder tab adds to the codeplug being edited: channels, contacts,
// RX group lists, zones and an APRS configuration, from a location, the
// standard packs, chosen repeaters, chosen talkgroups and the DMR simplex plan.
//
// It appends to the open model rather than replacing it, and it names every
// record uniquely against what is already there, so a build is one undoable
// change the editor can then save, validate or write to a radio like any other.
// Pure JavaScript with no DOM: tests/builder.test.mjs runs it directly.

import { newChannel, newContact } from "../model.js";
import { LIMITS } from "../records.js";
import { parseTone, nameBytes } from "../fields.js";
import { PACK_BY_ID, packApplies, packChannels, aprsFrequencyFor } from "./packs.js";
import { PLAN_BY_ID, planChannels } from "./dmr.js";
import { latLonToLocator, validLat, validLon } from "./geo.js";

export const RX_LIST_CONTACTS = LIMITS.rxListContacts;
export const ZONE_CHANNELS = LIMITS.zoneChannels;

const hz = (mhz) => Math.round(Number(mhz) * 1e5) * 10;

// A Brandmeister talkgroup slot: 1 or 2, anything else (0, null, a string) is
// "no override" — the channel's own slot decides.
const slotOf = (value) => (Number(value) === 1 || Number(value) === 2 ? Number(value) : 0);

// ASCII, no combining marks: the radio's name field is Latin-1, so a name with
// accents in it would arrive as question marks.
export function asciiName(value, fallback = "") {
	const text = String(value ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\x20-\x7E]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text || fallback;
}

function fit(text, max) {
	let out = text;
	while (out && nameBytes(out) > max) out = [...out].slice(0, -1).join("");
	return out;
}

function uniqueName(value, used, max, fallback) {
	const base = fit(asciiName(value, fallback), max).trim() || fallback;
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	for (let n = 2; n < 1000; n++) {
		const suffix = ` ${n}`;
		const stem = fit(base, max - nameBytes(suffix)).trim();
		const candidate = `${stem}${suffix}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
	let n = used.size;
	let candidate = fit(`${fallback}${n}`, max);
	while (used.has(candidate)) candidate = fit(`${fallback}${++n}`, max);
	used.add(candidate);
	return candidate;
}

// The names a table already holds, so added records never collide with them.
function takenNames(list) {
	const used = new Set();
	for (const item of list || []) if (item && item.name) used.add(item.name);
	return used;
}

const PROBLEMS = {
	no_dmr_id: "No DMR ID: the radio needs one before it can transmit on DMR.",
	no_name: "A record has no name.",
	too_long: "A name is longer than the radio stores and was cut.",
	bad_freq: "A frequency is outside the range the radio accepts.",
	bad_tone: "A tone is not a CTCSS or DCS tone the radio accepts.",
	range: "A value is outside the radio's range.",
	no_contact: "A DMR channel has no default contact.",
	duplicate: "Two records share a name; one was renamed.",
	too_many: "There are more records than the radio holds.",
	dangling: "A reference points at a record that is not in the codeplug.",
	out_of_band: "A frequency is outside the radio's band.",
};

// A validation problem as a sentence, for the page to show
export function problemText(problem) {
	const base = PROBLEMS[problem.code] || problem.code;
	const where = problem.item?.name || problem.item?.number;
	const table = problem.table ? `${problem.table}${where ? ` / ${where}` : ""}: ` : "";
	const params = problem.params && Object.keys(problem.params).length
		? ` (${Object.entries(problem.params).map(([k, v]) => `${k} ${v}`).join(", ")})`
		: "";
	return `${table}${base}${params}`;
}

// What a build did, for the status line: {channels, contacts, rxLists, zones,
// aprs} of records added, not of the codeplug.
export function applyPlan(model, input) {
	const warnings = [];
	const notes = [];
	const errors = [];
	const addWarning = (code, message) => {
		if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, message });
	};
	const addNote = (code, message) => {
		if (!notes.some((n) => n.code === code && n.message === message)) notes.push({ code, message });
	};
	const addError = (code, message) => {
		if (!errors.some((e) => e.code === code && e.message === message)) errors.push({ code, message });
	};

	const location = input.location || {};
	const station = input.station || {};
	const options = input.options || {};
	const country = String(input.country || "").toUpperCase();
	const region = input.region || "R1";
	const selectedPacks = Array.isArray(input.packs) ? input.packs : [];
	const selectedDmr = Array.isArray(input.dmr) ? input.dmr : [];
	const selectedAnalog = Array.isArray(input.analog) ? input.analog : [];
	const chosenContacts = Array.isArray(input.contacts) ? input.contacts : [];
	const simplex = input.dmrSimplex && input.dmrSimplex.enabled ? input.dmrSimplex : null;

	if (!validLat(Number(location.lat)) || !validLon(Number(location.lon))) {
		addError("no_location", "Set your latitude and longitude first.");
	}
	if (!selectedPacks.length && !selectedDmr.length && !selectedAnalog.length && !simplex && !chosenContacts.length) {
		addError("nothing_selected", "Select at least one pack, repeater, contact or the simplex plan.");
	}
	if (errors.length) return { ok: false, errors, warnings, notes, added: { channels: 0, contacts: 0, rxLists: 0, zones: 0, aprs: 0 } };

	const before = {
		channels: model.channels.length,
		contacts: model.contacts.length,
		rxLists: model.rxLists.length,
		zones: model.zones.length,
		aprs: model.aprs.length,
	};

	const usedChannelNames = takenNames(model.channels);
	const usedContactNames = takenNames(model.contacts);
	const usedListNames = takenNames(model.rxLists);
	const usedZoneNames = takenNames(model.zones);
	const contactsByKey = new Map();
	for (const contact of model.contacts) contactsByKey.set(`${contact.type}:${contact.id}:${contact.timeslot || 0}`, contact);

	const callsign = asciiName(station.callsign, "").toUpperCase().replace(/[^A-Z0-9/]/g, "");
	if (callsign && !model.general.radioName) {
		model.general.radioName = fit(callsign, LIMITS.radioName);
		addNote("name_set", `Radio name set to ${model.general.radioName}.`);
	} else if (callsign && model.general.radioName !== fit(callsign, LIMITS.radioName)) {
		addNote("name_kept", `The codeplug's radio name ("${model.general.radioName}") was kept; the callsign was not written over it.`);
	}
	if (callsign && nameBytes(callsign) > LIMITS.radioName) {
		addWarning("callsign_long", `Callsign ${callsign} is longer than the ${LIMITS.radioName} characters the radio shows; it was cut.`);
	}
	const dmrId = Number.parseInt(String(station.dmrId ?? ""), 10);
	if (Number.isInteger(dmrId) && dmrId > 0 && dmrId <= 0xffffff) {
		if (!model.general.dmrId) {
			model.general.dmrId = dmrId;
			addNote("dmr_id_set", `DMR ID set to ${dmrId}.`);
		} else if (model.general.dmrId !== dmrId) {
			addNote("dmr_id_kept", `The codeplug's DMR ID (${model.general.dmrId}) was kept; ${dmrId} was not written over it.`);
		}
	} else if (selectedDmr.length || simplex) {
		addWarning("no_dmr_id", "No valid DMR ID: DMR channels are added, but the radio needs an ID to transmit.");
	}

	for (const id of selectedPacks) {
		const pack = PACK_BY_ID.get(id);
		if (pack && !packApplies(pack, region, country)) {
			addWarning("pack_region", `${pack.title} is not part of ${region}${country ? `/${country}` : ""}; it was added anyway.`);
		}
	}

	let folded = 0;
	let truncated = 0;
	let badTones = 0;
	let tones = 0;

	const cleanChannelName = (value, fallback) => {
		const raw = asciiName(value, fallback);
		const name = uniqueName(raw, usedChannelNames, LIMITS.name, fallback);
		if (name.length < raw.length) truncated++;
		return name;
	};

	// Brandmeister publishes the slot each static talkgroup is subscribed to at
	// each repeater; that slot becomes the contact's timeslot override.
	const slotsByTg = new Map();
	for (const repeater of selectedDmr) {
		if (!repeater || !Array.isArray(repeater.talkgroups)) continue;
		for (const tg of repeater.talkgroups) {
			const id = Number(tg?.tg);
			const slot = slotOf(tg?.slot);
			if (!(id > 0) || !slot) continue;
			if (!slotsByTg.has(id)) slotsByTg.set(id, new Set());
			slotsByTg.get(id).add(slot);
		}
	}

	// A talkgroup the page chose without a slot will also be a plain contact, so
	// the repeater's variant has to say which slot it pins.
	const browsed = new Map();
	for (const entry of chosenContacts) {
		const tg = Number(entry && entry.tg);
		if (tg > 0) browsed.set(tg, String(entry.name || `TG ${tg}`));
	}

	const contactName = (baseName, number, slot) => {
		const ambiguous = (slotsByTg.get(number)?.size || 0) > 1 || browsed.has(number);
		return ambiguous && slot ? `${baseName} TS${slot}` : baseName;
	};

	const makeContact = (rawName, number, type, slot = 0) => {
		const override = slotOf(slot);
		const key = `${type}:${number}:${override}`;
		if (contactsByKey.has(key)) return { contact: contactsByKey.get(key), added: false };
		const fallback = type === "all" ? "AllCall" : `TG ${number}`;
		const name = uniqueName(contactName(rawName || fallback, number, override), usedContactNames, LIMITS.name, fallback);
		if (asciiName(rawName || "", "") !== (rawName || "")) folded++;
		if (name.length < asciiName(rawName || fallback, "").length) truncated++;
		const contact = newContact({ number: null, name, id: number, type, timeslot: override });
		model.contacts.push(contact);
		contactsByKey.set(key, contact);
		return { contact, added: true };
	};

	const tone = (value) => {
		const raw = String(value ?? "").trim();
		if (!raw) return "";
		const parsed = parseTone(raw);
		if (parsed === null) {
			badTones++;
			return "";
		}
		if (parsed) tones++;
		return parsed;
	};

	const dmrChannels = [];
	const analogChannels = [];
	const standardChannels = [];
	const aprsChannels = [];
	const simplexChannels = [];
	const accessChannels = [];
	let contactsAdded = 0;
	let listsAdded = 0;
	let overrides = 0;

	for (const repeater of selectedDmr) {
		if (!repeater) continue;
		let talkgroups = Array.isArray(repeater.talkgroups) ? repeater.talkgroups.filter((tg) => tg && Number(tg.tg) > 0) : [];
		if (!talkgroups.length && options.fallbackTg !== false) {
			talkgroups = [{ tg: 9, slot: 0, name: "Local" }];
			addWarning("no_talkgroups", `${repeater.callsign || repeater.id}: no static talkgroups came back; TG 9 (Local) is the default contact.`);
		}
		const made = talkgroups.slice(0, RX_LIST_CONTACTS).map((tg) => {
			const result = makeContact(String(tg.name || `TG ${tg.tg}`), Number(tg.tg), "group", tg.slot);
			if (result.added) {
				contactsAdded++;
				if (result.contact.timeslot) overrides++;
			}
			return result.contact;
		});
		if (talkgroups.length > RX_LIST_CONTACTS) {
			addWarning("rx_list_truncated", `${repeater.callsign || repeater.id}: ${talkgroups.length} talkgroups, but an RX group list holds ${RX_LIST_CONTACTS}; the rest are not in the list.`);
		}
		let list = null;
		if (made.length) {
			list = {
				number: null,
				name: uniqueName(repeater.callsign || `DMR ${repeater.id}`, usedListNames, LIMITS.name, "DMR"),
				contacts: made,
			};
			model.rxLists.push(list);
			listsAdded++;
		}
		const first = made[0] || null;
		if (!first) addWarning("no_default_contact", `${repeater.callsign || repeater.id}: no talkgroup to use as the default contact.`);
		const channel = newChannel({
			number: null,
			name: cleanChannelName(repeater.callsign || `DMR ${repeater.id}`, "DMR"),
			rxHz: hz(repeater.downlink_mhz),
			txHz: hz(repeater.uplink_mhz),
			mode: "dmr",
			power: 0,
			colorCode: Math.max(0, Math.min(15, Number(repeater.color_code) || 0)),
			timeslot: slotOf(talkgroups[0]?.slot) === 2 ? 2 : 1,
			contact: first,
			rxList: list,
		});
		model.channels.push(channel);
		dmrChannels.push(channel);
	}

	// Contacts picked in the talkgroup browser: plain group calls, no override.
	let browsedAdded = 0;
	let browsedShared = 0;
	for (const [tg, name] of browsed) {
		const existing = model.contacts.find((contact) => contact.id === tg && contact.type === "group" && !contact.timeslot);
		if (existing) {
			browsedShared++;
			continue;
		}
		const result = makeContact(name, tg, "group", 0);
		if (result.added) {
			browsedAdded++;
			contactsAdded++;
		}
	}
	if (browsedAdded || browsedShared) {
		const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
		let message;
		if (browsedAdded) {
			message = `${plural(browsedAdded, "talkgroup contact")} added from the talkgroup browser, with no timeslot override`;
			if (browsedShared) message += ` (${browsedShared} ${browsedShared === 1 ? "was" : "were"} already in the contacts table)`;
			message += ".";
		} else {
			message = `No new contact was needed from the talkgroup browser: ${browsedShared} ${browsedShared === 1 ? "was" : "were"} already in the contacts table.`;
		}
		addNote("contacts_added", message);
	}

	if (simplex) {
		const plan = PLAN_BY_ID.get(simplex.plan || "es");
		if (!plan) {
			addWarning("simplex_plan_unknown", `Unknown DMR simplex plan "${simplex.plan}"; no simplex channels were added.`);
		} else {
			if (plan.countries?.length && country && !plan.countries.includes(country)) {
				addWarning("simplex_country", `${plan.title} is a national agreement for ${plan.countries.join(", ")}; it was added for ${country} anyway.`);
			}
			const choice = ["tg99", "all", "both"].includes(simplex.choice) ? simplex.choice : "tg99";
			if (choice !== simplex.choice) addWarning("simplex_contact_unknown", `Unknown DMR simplex contact "${simplex.choice}"; TG 99 was used.`);
			for (const entry of planChannels(plan.id, { choice, includeAccess: simplex.includeAccess === true })) {
				const result = makeContact(entry.contact.contactName, entry.contact.number, entry.contact.type, 0);
				if (result.added) contactsAdded++;
				const channel = newChannel({
					number: null,
					name: cleanChannelName(entry.name, entry.base),
					rxHz: hz(entry.mhz),
					txHz: hz(entry.mhz),
					mode: "dmr",
					power: 0,
					colorCode: entry.colorCode,
					timeslot: entry.timeslot,
					contact: result.contact,
					dmo: true,
				});
				model.channels.push(channel);
				if (entry.kind === "access") accessChannels.push(channel);
				else simplexChannels.push(channel);
			}
			addNote(
				"simplex_added",
				`${simplexChannels.length} DMR simplex channel${simplexChannels.length === 1 ? "" : "s"} from the ${plan.title} plan` +
					(accessChannels.length ? `, plus ${accessChannels.length} access-point channel${accessChannels.length === 1 ? "" : "s"}` : "") +
					` (${choice === "both" ? "TG 99 and AllCall" : choice === "all" ? "AllCall" : "TG 99"}).`,
			);
			if (choice === "both") {
				addNote("simplex_both", "Each simplex frequency is two channels, one on TG 99 and one on AllCall, because a channel holds a single contact; the name says which.");
			}
		}
	}

	const seenAnalog = new Set();
	for (const repeater of selectedAnalog) {
		if (!repeater) continue;
		const key = `${repeater.callsign}:${repeater.downlink_mhz}:${repeater.uplink_mhz}`;
		if (seenAnalog.has(key)) continue;
		seenAnalog.add(key);
		if (!repeater.tx_tone) {
			addWarning("analog_no_tone", `${repeater.callsign || "analog repeater"} at ${Number(repeater.downlink_mhz).toFixed(4)} MHz has no tone listed; if it needs one, set it in the channel.`);
		}
		const channel = newChannel({
			number: null,
			name: cleanChannelName(repeater.callsign || "ANALOG", "ANALOG"),
			rxHz: hz(repeater.downlink_mhz),
			txHz: hz(repeater.uplink_mhz),
			mode: "fm",
			power: 0,
			bw: 12.5,
			txTone: tone(repeater.tx_tone),
			rxTone: tone(repeater.rx_tone),
		});
		model.channels.push(channel);
		analogChannels.push(channel);
	}

	for (const spec of packChannels(selectedPacks, { region, country })) {
		const channel = newChannel({
			number: null,
			name: cleanChannelName(spec.name, "CH"),
			rxHz: hz(spec.rx),
			txHz: hz(spec.tx ?? spec.rx),
			mode: spec.mode || "fm",
			power: Number.isInteger(spec.power) ? spec.power : 0,
			bw: spec.bw ?? 12.5,
			rxOnly: !!spec.rxOnly,
			txTone: tone(spec.txTone),
			rxTone: tone(spec.rxTone),
		});
		if (spec.rxOnly) channel.txHz = channel.rxHz;
		model.channels.push(channel);
		if (String(spec.pack || "").startsWith("aprs_")) aprsChannels.push({ channel, spec });
		else standardChannels.push(channel);
	}

	let aprsAdded = 0;
	if (options.aprsConfig !== false && callsign && aprsChannels.length) {
		const wanted = hz(aprsFrequencyFor(country));
		const target = aprsChannels.find((entry) => entry.channel.rxHz === wanted) || aprsChannels[0];
		const ssid = Math.max(0, Math.min(15, Number(options.aprsSsid ?? 7) || 0));
		const aprsName = fit(`${callsign}-${ssid}`, LIMITS.aprsName);
		if (aprsName !== `${callsign}-${ssid}`) {
			addWarning("aprs_name_long", `APRS name ${callsign}-${ssid} is longer than ${LIMITS.aprsName} characters and was cut; the SSID may be missing.`);
		}
		const locator = latLonToLocator(Number(location.lat), Number(location.lon), 6);
		const entry = {
			number: null,
			name: aprsName,
			ssid,
			lat: Number(location.lat),
			lon: Number(location.lon),
			useFixed: true,
			txHz: target.channel.rxHz,
			path1: "WIDE1",
			path2: "WIDE2",
			symTable: "/",
			symCode: ">",
			comment: locator.slice(0, LIMITS.aprsComment),
			baud300: false,
			qsy: true,
			silent: false,
			ambiguity: 0,
		};
		model.aprs.push(entry);
		target.channel.aprs = entry;
		aprsAdded++;
		addNote("aprs_config", `APRS position ${locator} added on ${(target.channel.rxHz / 1e6).toFixed(3)} MHz as ${aprsName}.`);
	}

	if (folded) addWarning("names_folded", `${folded} name(s) lost characters the radio cannot show.`);
	if (truncated) addWarning("names_truncated", `Some names were shortened to the radio's ${LIMITS.name}-character field.`);
	if (badTones) addWarning("tones_dropped", `${badTones} CTCSS/DCS tone(s) could not be read and were left empty.`);
	if (overrides) addNote("timeslot_overrides", `${overrides} talkgroup contact${overrides === 1 ? " carries" : "s carry"} the timeslot override Brandmeister publishes for ${overrides === 1 ? "it" : "them"}.`);

	const addZones = (base, channels) => {
		if (!channels.length) return;
		for (let index = 0; index < channels.length; index += ZONE_CHANNELS) {
			const part = Math.floor(index / ZONE_CHANNELS) + 1;
			const suffix = channels.length > ZONE_CHANNELS ? ` ${part}` : "";
			const name = uniqueName(`${base}${suffix}`, usedZoneNames, LIMITS.name, "ZONE");
			model.zones.push({ name, channels: channels.slice(index, index + ZONE_CHANNELS) });
		}
	};
	addZones("DMR", dmrChannels);
	addZones("DMR SIMPLEX", simplexChannels);
	addZones("DMR ACCESS", accessChannels);
	addZones("ANALOG", analogChannels);
	addZones("STANDARD", standardChannels);
	addZones("APRS", aprsChannels.map((entry) => entry.channel));

	const added = {
		channels: model.channels.length - before.channels,
		contacts: contactsAdded,
		rxLists: listsAdded,
		zones: model.zones.length - before.zones,
		aprs: aprsAdded,
	};
	const limits = [
		["channels", LIMITS.channels],
		["contacts", LIMITS.contacts],
		["zones", LIMITS.zones],
		["rxLists", LIMITS.rxLists],
		["aprs", LIMITS.aprs],
	];
	for (const [table, max] of limits) {
		if (model[table].length > max) {
			addError("too_many", `This codeplug would hold ${model[table].length} ${table}; the radio holds ${max}, so ${added[table] ? "this build" : "it"} cannot be saved. Undo and choose fewer.`);
		}
	}
	if (tones === 0 && analogChannels.length) addNote("no_tones", "No analog repeater in this build has a tone; check each one before transmitting.");
	return { ok: errors.length === 0, errors, warnings, notes, added, counts: { ...added } };
}
