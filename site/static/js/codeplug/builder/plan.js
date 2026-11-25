// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Copyright (c) 2026 The RadioFoundry-cp-builder Authors
// What the Builder tab adds to the codeplug being edited, one thing at a time.
//
// Each source — a DMR repeater, an analog repeater, a channel pack, a chosen
// talkgroup, the simplex plan, the APRS position — is added and taken away on
// its own: one call per tick, each inside one editor change, so a tick is one
// undo step. Every add returns a receipt listing the
// records it created; the matching remove takes exactly those away again and
// leaves anything another source (or the user) still uses.
//
// Records are tracked by object identity. The editor's undo restores the same
// record objects into the model, so a receipt stays valid across undo and redo.
//
// Pure JavaScript with no DOM: site/tests/builder.test.mjs runs it directly.

import { newChannel, newContact, remove } from "../model.js";
import { LIMITS } from "../records.js";
import { parseTone, nameBytes } from "../fields.js";
import { PACK_BY_ID, packApplies, packChannels, aprsFrequencyFor } from "./packs.js";
import { PLAN_BY_ID, planChannels } from "./dmr.js";
import { latLonToLocator, validLat, validLon } from "./geo.js";

export const RX_LIST_CONTACTS = LIMITS.rxListContacts;
export const ZONE_CHANNELS = LIMITS.zoneChannels;
export const ZONE_NAMES = {
	dmr: "DMR",
	simplex: "DMR SIMPLEX",
	access: "DMR ACCESS",
	analog: "ANALOG",
	standard: "STANDARD",
	aprs: "APRS",
};

const hz = (mhz) => Math.round(Number(mhz) * 1e5) * 10;

// A Brandmeister talkgroup slot: 1 or 2, anything else is "no override".
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

const names = (list) => new Set((list || []).map((item) => item?.name).filter(Boolean));

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

// --- receipts ---------------------------------------------------------------
//
// What one tick added, so the opposite tick can take exactly that away again.

function emptyReceipt() {
	return { channels: [], contacts: [], rxLists: [], aprs: [], zones: [], createdZones: [] };
}

function receiptSize(receipt) {
	return receipt.channels.length + receipt.contacts.length + receipt.rxLists.length + receipt.aprs.length;
}

// The records of a receipt still in the model: the first of each table, which
// is all a presence check needs.
function presentIn(model, receipt) {
	if (!receipt) return false;
	const any = (table, list) => list.some((record) => model[table].includes(record));
	return any("channels", receipt.channels) || any("contacts", receipt.contacts)
		|| any("rxLists", receipt.rxLists) || any("aprs", receipt.aprs);
}

// Per-model, per-key receipts. A WeakMap: a codeplug opened over another one
// leaves its ledger behind with it.
const ledgers = new WeakMap();



function ledger(model) {
	let map = ledgers.get(model);
	if (!map) {
		map = new Map();
		ledgers.set(model, map);
	}
	return map;
}

// Whether a source's records are in the codeplug now — what a tick shows.
export function hasSource(model, key) {
	return presentIn(model, ledger(model).get(key));
}

export function sourceKeys(model) {
	return [...ledger(model).keys()].filter((key) => presentIn(model, ledger(model).get(key)));
}

// Forget a source without touching the model (a new codeplug replaced the old one).
export function forgetSource(model, key) {
	ledger(model).delete(key);
}

// --- building blocks --------------------------------------------------------

// The names a table already holds, read fresh: a tick may follow the user
// renaming a record by hand.
function scene(model) {
	return {
		channelNames: names(model.channels),
		contactNames: names(model.contacts),
		listNames: names(model.rxLists),
		zoneNames: names(model.zones),
	};
}

// A contact the Builder put in, so it may be renamed to keep two variants apart
function ours(model, contact) {
	for (const receipt of ledger(model).values()) if (receipt.contacts.includes(contact)) return true;
	return false;
}

// An existing contact for (type, id, slot override), or a new one. A talkgroup
// used twice is one contact; a talkgroup pinned to two slots is two. When the
// same talkgroup is both pinned (by a repeater) and chosen plainly (from the
// table), the pinned one says which slot it pins, so the two read apart.
function contactFor(model, sc, receipt, rawName, id, type, slot = 0) {
	const override = slotOf(slot);
	const found = model.contacts.find((c) => c.type === type && c.id === id && (c.timeslot || 0) === override);
	if (found) return found;
	const fallback = type === "all" ? "AllCall" : `TG ${id}`;
	const base = rawName || fallback;

	if (override === 0) {
		// a plain choice: name the pinned variants for their slots first
		for (const other of model.contacts) {
			if (other.type !== type || other.id !== id || !other.timeslot || !ours(model, other)) continue;
			if (/ TS[12]$/.test(other.name)) continue;
			const renamed = uniqueName(`${other.name} TS${other.timeslot}`, new Set([...sc.contactNames].filter((n) => n !== other.name)), LIMITS.name, fallback);
			sc.contactNames.delete(other.name);
			other.name = renamed;
			sc.contactNames.add(renamed);
		}
	}

	const pinned = override && model.contacts.some((c) => c.type === type && c.id === id && !c.timeslot);
	const name = uniqueName(pinned ? `${base} TS${override}` : base, sc.contactNames, LIMITS.name, fallback);
	const contact = newContact({ number: null, name, id, type, timeslot: override });
	model.contacts.push(contact);
	receipt.contacts.push(contact);
	return contact;
}

// The zone a group of channels belongs in: an existing one of that name, or a
// new one, remembered so an empty one can go again with the last channel.
function zoneFor(model, sc, receipt, name) {
	const found = model.zones.find((z) => z.name === name);
	if (found) return found;
	const zone = { name: uniqueName(name, sc.zoneNames, LIMITS.name, "ZONE"), channels: [] };
	model.zones.push(zone);
	receipt.zones.push(zone);
	receipt.createdZones.push(zone);
	return zone;
}

// Add channels to a zone, splitting into numbered zones past the radio's limit.
function placeInZone(model, sc, receipt, base, channels) {
	if (!channels.length) return;
	for (let index = 0; index < channels.length; index += ZONE_CHANNELS) {
		const part = Math.floor(index / ZONE_CHANNELS) + 1;
		const suffix = channels.length > ZONE_CHANNELS ? ` ${part}` : "";
		const zone = zoneFor(model, sc, receipt, `${base}${suffix}`);
		for (const channel of channels.slice(index, index + ZONE_CHANNELS)) if (!zone.channels.includes(channel)) zone.channels.push(channel);
	}
}

function toneOf(value, warn) {
	const raw = String(value ?? "").trim();
	if (!raw) return "";
	const parsed = parseTone(raw);
	if (parsed === null) {
		warn("tones_dropped", `${raw} is not a CTCSS or DCS tone the radio takes; left empty.`, { tone: raw });
		return "";
	}
	return parsed;
}

// --- sources ----------------------------------------------------------------

// A Brandmeister repeater: its channel, its talkgroup contacts and its RX group
// list. `talkgroups` is [{tg, slot, name}], the first of which becomes the
// channel's default contact.
export function addRepeater(model, repeater, { key = `dmr:${repeater?.id}`, fallbackTg = true } = {}) {
	const receipt = emptyReceipt();
	const warnings = [];
	const notes = [];
	const warn = (code, message, params) => {
		if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, message, ...(params ? { params } : {}) });
	};
	const sc = scene(model);

	let talkgroups = Array.isArray(repeater.talkgroups)
		? repeater.talkgroups.filter((tg) => tg && Number(tg.tg) > 0)
		: [];
	if (!talkgroups.length && fallbackTg) {
		talkgroups = [{ tg: 9, slot: 0, name: "Local" }];
		warn("no_talkgroups", `${repeater.callsign || repeater.id}: no static talkgroups listed; TG 9 (Local) is the default contact.`, { call: repeater.callsign || repeater.id });
	}

	const contacts = talkgroups.slice(0, RX_LIST_CONTACTS)
		.map((tg) => contactFor(model, sc, receipt, String(tg.name || `TG ${tg.tg}`), Number(tg.tg), "group", tg.slot));
	if (talkgroups.length > RX_LIST_CONTACTS) {
		warn("rx_list_truncated", `${repeater.callsign || repeater.id}: ${talkgroups.length} talkgroups, but an RX group list holds ${RX_LIST_CONTACTS}; the rest are not in the list.`, { call: repeater.callsign || repeater.id, n: talkgroups.length, max: RX_LIST_CONTACTS });
	}

	let list = null;
	if (contacts.length) {
		list = { number: null, name: uniqueName(repeater.callsign || `DMR ${repeater.id}`, sc.listNames, LIMITS.name, "DMR"), contacts };
		model.rxLists.push(list);
		receipt.rxLists.push(list);
	}
	if (!contacts.length) warn("no_default_contact", `${repeater.callsign || repeater.id}: no talkgroup to use as the default contact.`, { call: repeater.callsign || repeater.id });

	const channel = newChannel({
		number: null,
		name: uniqueName(repeater.callsign || `DMR ${repeater.id}`, sc.channelNames, LIMITS.name, "DMR"),
		rxHz: hz(repeater.downlink_mhz),
		txHz: hz(repeater.uplink_mhz),
		mode: "dmr",
		power: 0,
		colorCode: Math.max(0, Math.min(15, Number(repeater.color_code) || 0)),
		timeslot: slotOf(talkgroups[0]?.slot) === 2 ? 2 : 1,
		contact: contacts[0] || null,
		rxList: list,
	});
	model.channels.push(channel);
	receipt.channels.push(channel);
	placeInZone(model, sc, receipt, ZONE_NAMES.dmr, [channel]);

	const overrides = contacts.filter((c) => c.timeslot).length;
	if (overrides) {
		notes.push({
			code: "timeslot_overrides",
			message: `${overrides} talkgroup contact${overrides === 1 ? " carries" : "s carry"} the timeslot override Brandmeister publishes.`,
			params: { n: overrides },
		});
	}
	ledger(model).set(key, receipt);
	return { ok: true, receipt, warnings, notes };
}

// An analog repeater: one FM channel with its shift and tones.
export function addAnalog(model, repeater, { key } = {}) {
	const receipt = emptyReceipt();
	const warnings = [];
	const sc = scene(model);
	const id = key || `analog:${repeater.source || "h"}:${repeater.callsign}:${repeater.downlink_mhz}:${repeater.uplink_mhz}`;
	const warn = (code, message, params) => warnings.push({ code, message, ...(params ? { params } : {}) });
	if (!repeater.tx_tone) {
		warn("analog_no_tone", `${repeater.callsign || "analog repeater"} at ${Number(repeater.downlink_mhz).toFixed(4)} MHz has no tone listed; if it needs one, set it in the channel.`, { call: repeater.callsign || "", mhz: Number(repeater.downlink_mhz).toFixed(4) });
	}
	const channel = newChannel({
		number: null,
		name: uniqueName(repeater.callsign || "ANALOG", sc.channelNames, LIMITS.name, "ANALOG"),
		rxHz: hz(repeater.downlink_mhz),
		txHz: hz(repeater.uplink_mhz),
		mode: "fm",
		power: 0,
		bw: 12.5,
		txTone: toneOf(repeater.tx_tone, warn),
		rxTone: toneOf(repeater.rx_tone, warn),
	});
	model.channels.push(channel);
	receipt.channels.push(channel);
	placeInZone(model, sc, receipt, ZONE_NAMES.analog, [channel]);
	ledger(model).set(id, receipt);
	return { ok: true, receipt, warnings, notes: [] };
}

// A channel pack: its channels, in their own zone.
export function addPack(model, packId, { region = "R1", country = "" } = {}) {
	const pack = PACK_BY_ID.get(packId);
	const receipt = emptyReceipt();
	const warnings = [];
	if (!pack) return { ok: false, receipt, warnings, notes: [] };
	if (!packApplies(pack, region, country)) {
		warnings.push({ code: "pack_region", message: `${pack.title} is not part of ${region}${country ? `/${country}` : ""}; it was added anyway.`, params: { name: pack.title, region, country } });
	}
	const sc = scene(model);
	const channels = [];
	for (const spec of packChannels([packId], { region, country })) {
		const channel = newChannel({
			number: null,
			name: uniqueName(spec.name, sc.channelNames, LIMITS.name, "CH"),
			rxHz: hz(spec.rx),
			txHz: hz(spec.tx ?? spec.rx),
			mode: spec.mode || "fm",
			power: Number.isInteger(spec.power) ? spec.power : 0,
			bw: spec.bw ?? 12.5,
			rxOnly: !!spec.rxOnly,
			txTone: toneOf(spec.txTone, (code, message) => warnings.push({ code, message })),
			rxTone: toneOf(spec.rxTone, (code, message) => warnings.push({ code, message })),
		});
		if (spec.rxOnly) channel.txHz = channel.rxHz;
		model.channels.push(channel);
		receipt.channels.push(channel);
		channels.push(channel);
	}
	const base = packId.startsWith("aprs_") ? ZONE_NAMES.aprs : ZONE_NAMES.standard;
	placeInZone(model, sc, receipt, base, channels);
	ledger(model).set(`pack:${packId}`, receipt);
	return { ok: true, receipt, warnings, notes: [] };
}

// One talkgroup chosen from the table: a plain group contact, no override, so
// it works on any DMR channel.
export function addTalkgroup(model, { tg, name }, { key } = {}) {
	const number = Number(tg);
	const receipt = emptyReceipt();
	if (!(number > 0)) return { ok: false, receipt, warnings: [], notes: [] };
	const sc = scene(model);
	const contact = contactFor(model, sc, receipt, String(name || `TG ${number}`), number, "group", 0);
	ledger(model).set(key || `tg:${number}`, receipt);
	return { ok: true, receipt, contact, warnings: [], notes: [] };
}

// The DMR simplex plan: its channels, and the TG 99 / AllCall contacts it uses.
export function addSimplex(model, { plan = "es", choice = "tg99", includeAccess = false, country = "" } = {}) {
	const receipt = emptyReceipt();
	const warnings = [];
	const notes = [];
	const planDef = PLAN_BY_ID.get(plan);
	if (!planDef) {
		warnings.push({ code: "simplex_plan_unknown", message: `Unknown DMR simplex plan "${plan}"; no simplex channels were added.`, params: { plan } });
		return { ok: false, receipt, warnings, notes };
	}
	if (planDef.countries?.length && country && !planDef.countries.includes(country)) {
		warnings.push({ code: "simplex_country", message: `${planDef.title} is a national agreement for ${planDef.countries.join(", ")}; it was added for ${country} anyway.`, params: { name: planDef.title, countries: planDef.countries.join(", "), country } });
	}
	const use = ["tg99", "all", "both"].includes(choice) ? choice : "tg99";
	if (use !== choice) warnings.push({ code: "simplex_contact_unknown", message: `Unknown DMR simplex contact "${choice}"; TG 99 was used.`, params: { choice } });
	const sc = scene(model);
	const voice = [];
	const access = [];
	for (const entry of planChannels(planDef.id, { choice: use, includeAccess })) {
		const contact = contactFor(model, sc, receipt, entry.contact.contactName, entry.contact.number, entry.contact.type, 0);
		const channel = newChannel({
			number: null,
			name: uniqueName(entry.name, sc.channelNames, LIMITS.name, entry.base),
			rxHz: hz(entry.mhz),
			txHz: hz(entry.mhz),
			mode: "dmr",
			power: 0,
			colorCode: entry.colorCode,
			timeslot: entry.timeslot,
			contact,
			dmo: true,
		});
		model.channels.push(channel);
		receipt.channels.push(channel);
		(entry.kind === "access" ? access : voice).push(channel);
	}
	placeInZone(model, sc, receipt, ZONE_NAMES.simplex, voice);
	placeInZone(model, sc, receipt, ZONE_NAMES.access, access);
	notes.push({
		code: "simplex_added",
		message: `${voice.length} DMR simplex channel${voice.length === 1 ? "" : "s"} from the ${planDef.title} plan` +
			(access.length ? `, plus ${access.length} access-point channel${access.length === 1 ? "" : "s"}` : "") +
			` (${use === "both" ? "TG 99 and AllCall" : use === "all" ? "AllCall" : "TG 99"}).`,
		params: { n: voice.length, plan: planDef.title, access: access.length, contact: use },
	});
	if (use === "both") {
		notes.push({
			code: "simplex_both",
			message: "Each simplex frequency is two channels, one on TG 99 and one on AllCall, because a channel holds a single contact; the name says which.",
		});
	}
	ledger(model).set("simplex", receipt);
	return { ok: true, receipt, warnings, notes };
}

// The APRS position at the location, linked to an APRS channel as its revert
// channel. The channel has to be there already (the APRS pack adds it).
export function addAprs(model, { location, callsign, ssid = 7, country = "", key = "aprs" } = {}) {
	const receipt = emptyReceipt();
	const warnings = [];
	const notes = [];
	const call = asciiName(callsign, "").toUpperCase().replace(/[^A-Z0-9/]/g, "");
	if (!call || !validLat(Number(location?.lat)) || !validLon(Number(location?.lon))) {
		return { ok: false, receipt, warnings, notes };
	}
	const wanted = hz(aprsFrequencyFor(country));
	const target = model.channels.find((c) => c.mode === "fm" && c.rxHz === wanted)
		|| model.channels.find((c) => c.mode === "fm" && c.aprs);
	if (!target) {
		warnings.push({ code: "aprs_no_channel", message: "Add an APRS pack first: the position needs a channel to transmit on." });
		return { ok: false, receipt, warnings, notes };
	}
	const id = Math.max(0, Math.min(15, Number(ssid) || 0));
	const name = fit(`${call}-${id}`, LIMITS.aprsName);
	if (name !== `${call}-${id}`) warnings.push({ code: "aprs_name_long", message: `APRS name ${call}-${id} is longer than ${LIMITS.aprsName} characters and was cut; the SSID may be missing.`, params: { name: `${call}-${id}`, max: LIMITS.aprsName } });
	const locator = latLonToLocator(Number(location.lat), Number(location.lon), 6);
	const entry = {
		number: null,
		name,
		ssid: id,
		lat: Number(location.lat),
		lon: Number(location.lon),
		useFixed: true,
		txHz: target.rxHz,
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
	receipt.aprs.push(entry);
	const had = target.aprs;
	target.aprs = entry;
	notes.push({ code: "aprs_config", message: `APRS position ${locator} added on ${(target.rxHz / 1e6).toFixed(3)} MHz as ${name}.`, params: { locator, mhz: (target.rxHz / 1e6).toFixed(3), name } });
	ledger(model).set(key, receipt);
	return { ok: true, receipt, warnings, notes, previous: [target, had] };
}

// Take one source's records away again. Only what the receipt holds goes, and
// only while nothing else still points at it: a contact another channel uses,
// or a zone the user filled, stays. Returns what was removed.
export function removeSource(model, key) {
	const map = ledger(model);
	const receipt = map.get(key);
	if (!receipt) return { ok: false, removed: emptyReceipt() };
	const removed = emptyReceipt();

	// An APRS configuration this source added, and the channel link to it
	for (const entry of receipt.aprs) {
		for (const channel of model.channels) if (channel.aprs === entry) channel.aprs = null;
	}
	if (receipt.aprs.length) {
		remove(model, "aprs", receipt.aprs.filter((entry) => model.aprs.includes(entry)));
		removed.aprs = receipt.aprs;
	}

	// Channels (remove() also takes them out of every zone)
	const channels = receipt.channels.filter((channel) => model.channels.includes(channel));
	if (channels.length) {
		remove(model, "channels", channels);
		removed.channels = channels;
	}

	// RX group lists nothing else uses
	const lists = receipt.rxLists.filter((list) => model.rxLists.includes(list)
		&& !model.channels.some((channel) => channel.rxList === list));
	if (lists.length) {
		remove(model, "rxLists", lists);
		removed.rxLists = lists;
	}

	// Contacts nothing else uses
	const contacts = receipt.contacts.filter((contact) => model.contacts.includes(contact)
		&& !model.channels.some((channel) => channel.contact === contact)
		&& !model.rxLists.some((list) => list.contacts.includes(contact)));
	if (contacts.length) {
		remove(model, "contacts", contacts);
		removed.contacts = contacts;
	}

	// Zones this source created and left empty
	const zones = receipt.createdZones.filter((zone) => model.zones.includes(zone) && zone.channels.length === 0);
	if (zones.length) {
		model.zones = model.zones.filter((zone) => !zones.includes(zone));
		removed.zones = zones;
	}

	// The receipt stays: the editor's Undo puts the same records back, and the
	// ticks read their state from whether those records are in the model.
	return { ok: true, removed };
}

// --- station fields ---------------------------------------------------------

// The callsign and DMR ID fill the codeplug's own fields, but only where they
// are still empty: what is there is the user's, not the Builder's.
export function applyStation(model, { callsign = "", dmrId = "" } = {}) {
	const notes = [];
	const warnings = [];
	const call = asciiName(callsign, "").toUpperCase().replace(/[^A-Z0-9/]/g, "");
	if (call) {
		const name = fit(call, LIMITS.radioName);
		if (nameBytes(call) > LIMITS.radioName) warnings.push({ code: "callsign_long", message: `Callsign ${call} is longer than the ${LIMITS.radioName} characters the radio shows; it was cut.`, params: { call, max: LIMITS.radioName } });
		if (!model.general.radioName) {
			model.general.radioName = name;
			notes.push({ code: "name_set", message: `Radio name set to ${name}.`, params: { name } });
		} else if (model.general.radioName !== name) {
			notes.push({ code: "name_kept", message: `The radio name ("${model.general.radioName}") was kept; ${call} was not written over it.`, params: { kept: model.general.radioName, call } });
		}
	}
	const id = Number.parseInt(String(dmrId ?? ""), 10);
	if (Number.isInteger(id) && id > 0 && id <= 0xffffff) {
		if (!model.general.dmrId) {
			model.general.dmrId = id;
			notes.push({ code: "dmr_id_set", message: `DMR ID set to ${id}.`, params: { id } });
		} else if (model.general.dmrId !== id) {
			notes.push({ code: "dmr_id_kept", message: `The DMR ID (${model.general.dmrId}) was kept; ${id} was not written over it.`, params: { kept: model.general.dmrId, id } });
		}
	}
	return { warnings, notes };
}

// --- the whole thing at once ------------------------------------------------

// Every choice applied in one go, for tests and for a codeplug built in one
// step. The page does not use this: it adds each source as it is ticked.
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
	const options = input.options || {};
	const country = String(input.country || "").toUpperCase();
	const region = input.region || "R1";
	const packs = Array.isArray(input.packs) ? input.packs : [];
	const dmr = Array.isArray(input.dmr) ? input.dmr : [];
	const analog = Array.isArray(input.analog) ? input.analog : [];
	const contacts = Array.isArray(input.contacts) ? input.contacts : [];
	const simplex = input.dmrSimplex && input.dmrSimplex.enabled ? input.dmrSimplex : null;

	if (!validLat(Number(location.lat)) || !validLon(Number(location.lon))) addError("no_location", "Set your latitude and longitude first.");
	if (!packs.length && !dmr.length && !analog.length && !simplex && !contacts.length) {
		addError("nothing_selected", "Select at least one pack, repeater, contact or the simplex plan.");
	}
	if (errors.length) return { ok: false, errors, warnings, notes, added: { channels: 0, contacts: 0, rxLists: 0, zones: 0, aprs: 0 } };

	const before = { channels: model.channels.length, contacts: model.contacts.length, zones: model.zones.length, aprs: model.aprs.length };
	const collect = (result) => {
		for (const warning of result.warnings) addWarning(warning.code, warning.message);
		for (const note of result.notes) addNote(note.code, note.message);
	};

	const station = applyStation(model, input.station || {});
	for (const w of station.warnings) addWarning(w.code, w.message);
	for (const n of station.notes) addNote(n.code, n.message);

	// DMR repeaters first: their talkgroups name the shared contacts
	for (const repeater of dmr) {
		if (!repeater) continue;
		collect(addRepeater(model, repeater, { fallbackTg: options.fallbackTg !== false }));
	}
	let added = 0;
	for (const entry of contacts) {
		const result = addTalkgroup(model, entry);
		if (result.ok && result.contact) added++;
		collect(result);
	}
	if (added) addNote("contacts_added", `${added} talkgroup contact${added === 1 ? "" : "s"} added from the talkgroup browser, with no timeslot override.`);
	if (simplex) collect(addSimplex(model, { ...simplex, country }));
	for (const repeater of analog) if (repeater) collect(addAnalog(model, repeater));
	for (const id of packs) collect(addPack(model, id, { region, country }));
	if (options.aprsConfig !== false && packs.some((id) => String(id).startsWith("aprs_"))) {
		const result = addAprs(model, { location, callsign: input.station?.callsign, ssid: options.aprsSsid, country });
		if (result.ok) collect(result);
	}
	if (!model.general.dmrId && (dmr.length || simplex)) addWarning("no_dmr_id", "No valid DMR ID: DMR channels are added, but the radio needs an ID to transmit.");

	const limits = [["channels", LIMITS.channels], ["contacts", LIMITS.contacts], ["zones", LIMITS.zones], ["rxLists", LIMITS.rxLists], ["aprs", LIMITS.aprs]];
	for (const [table, max] of limits) {
		if (model[table].length > max) addError("too_many", `This codeplug would hold ${model[table].length} ${table}; the radio holds ${max}.`);
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		notes,
		added: {
			channels: model.channels.length - before.channels,
			contacts: model.contacts.length - before.contacts,
			rxLists: 0,
			zones: model.zones.length - before.zones,
			aprs: model.aprs.length - before.aprs,
		},
	};
}
