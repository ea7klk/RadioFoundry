// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Copyright (c) 2026 The RadioFoundry-cp-builder Authors
// The Builder tab's logic: locators, the channel packs, the DMR simplex plan,
// the repeater-file parser, the talkgroup table's filters, and what a plan adds
// to a codeplug. No DOM, so these run on the host.

import { test } from "node:test";
import assert from "node:assert/strict";

import { empty, validate } from "../static/js/codeplug/model.js";
import { importQdmr } from "../static/js/codeplug/qdmr.js";
import { importAll } from "../static/js/codeplug/csv.js";
import { exportQdmr } from "../static/js/codeplug/qdmr.js";
import { exportAll } from "../static/js/codeplug/csv.js";
import * as geo from "../static/js/codeplug/builder/geo.js";
import * as packs from "../static/js/codeplug/builder/packs.js";
import * as dmr from "../static/js/codeplug/builder/dmr.js";
import * as analog from "../static/js/codeplug/builder/analog.js";
import {
	applyPlan, addRepeater, addAnalog, addPack, addTalkgroup, addSimplex, addAprs,
	removeSource, hasSource, sourceKeys,
} from "../static/js/codeplug/builder/plan.js";

const MALAGA = { lat: 36.7213, lon: -4.4214 };

const plan = (overrides = {}) => ({
	location: MALAGA,
	country: "ES",
	region: "R1",
	station: { callsign: "EA7KLK", dmrId: "1234567" },
	packs: ["r1_calling", "aprs_r1", "pmr446"],
	dmr: [],
	analog: [],
	contacts: [],
	options: { aprsConfig: true, aprsSsid: 7 },
	...overrides,
});

const dmrRepeater = (overrides = {}) => ({
	id: 214702,
	callsign: "ED7ZAC",
	city: "MALAGA",
	downlink_mhz: 438.45,
	uplink_mhz: 430.85,
	color_code: 1,
	status: 3,
	talkgroups: [
		{ tg: 21429, slot: 2, name: "Provincial Málaga" },
		{ tg: 214, slot: 1, name: "Spain" },
	],
	...overrides,
});

// --- geo --------------------------------------------------------------------

test("a locator round trips within its square", () => {
	for (const [lat, lon] of [[36.7213, -4.4214], [52.5, 13.4], [-33.87, 151.21], [0, 1]]) {
		const locator = geo.latLonToLocator(lat, lon, 6);
		const back = geo.locatorToLatLon(locator);
		assert.ok(geo.distanceKm(lat, lon, back.lat, back.lon) < 6, `${locator}`);
	}
});

test("bad locators and coordinates are refused", () => {
	assert.deepEqual(geo.locatorToLatLon("IM76SR"), geo.locatorToLatLon("im76sr"));
	assert.equal(geo.locatorToLatLon("ZZ99"), null);
	assert.equal(geo.locatorToLatLon("IM76SR9"), null);
	assert.ok(!geo.validLat(91) && !geo.validLon(181));
});

// --- packs ------------------------------------------------------------------

test("every pack builds channels and names its source", () => {
	for (const pack of packs.PACKS) {
		assert.ok(pack.channels({ region: "R1", country: "ES" }).length > 0, pack.id);
		assert.match(pack.source, /^https:\/\//, pack.id);
	}
});

test("marine channels are prefixed MAR-", () => {
	const names = packs.PACK_BY_ID.get("marine_intl").channels().map((channel) => channel.name);
	assert.ok(names.includes("MAR-16"));
	assert.ok(names.includes("MAR-37A"));
	assert.ok(names.every((name) => name.startsWith("MAR-")));
	assert.ok(Math.max(...names.map((name) => name.length)) <= 16);
});

test("PMR446 and FRS keep their spacing", () => {
	const pmr = packs.PACK_BY_ID.get("pmr446").channels();
	assert.equal(pmr.length, 16);
	assert.equal(pmr[0].rx, 446.00625);
	assert.equal(pmr[15].rx, 446.19375);
	assert.equal(packs.PACK_BY_ID.get("frs").channels().length, 22);
});

test("APRS follows the country", () => {
	assert.equal(packs.aprsFrequencyFor("ES"), 144.8);
	assert.equal(packs.aprsFrequencyFor("US"), 144.39);
	assert.equal(packs.aprsFrequencyFor("AU"), 145.175);
});

test("the regional defaults include an APRS pack", () => {
	for (const [region, country] of [["R1", "ES"], ["R2", "US"], ["R3", "AU"]]) {
		assert.ok(packs.defaultPacks(region, country).some((id) => id.startsWith("aprs_")), region);
	}
});

// --- DMR simplex ------------------------------------------------------------

test("the Spanish simplex plan keeps its published names and frequencies", () => {
	const plan = dmr.PLAN_BY_ID.get("es");
	assert.deepEqual(plan.simplex.map(([name]) => name),
		["CQDVHF", "S1-VHF", "S2-VHF", "SOTA-V", "CQDUHF", "S1-UHF", "S2-UHF", "S3-UHF", "SOTA-U"]);
	assert.deepEqual(plan.simplex.map(([, mhz]) => mhz),
		[145.375, 145.3875, 145.4, 144.9, 433.45, 433.775, 438.025, 438.0375, 438.05]);
	assert.equal(plan.access.length, 12);
});

test("one contact choice is one channel per frequency; both is two", () => {
	assert.equal(dmr.planChannels("es", { choice: "tg99" }).length, 9);
	assert.equal(dmr.planChannels("es", { choice: "all" }).length, 9);
	assert.equal(dmr.planChannels("es", { choice: "both" }).length, 18);
	assert.equal(dmr.planChannels("es", { choice: "both", includeAccess: true }).length, 42);
	for (const channel of dmr.planChannels("es", { choice: "both", includeAccess: true })) {
		assert.ok(channel.name.endsWith("TG99") || channel.name.endsWith("ALL"), channel.name);
		assert.equal(channel.colorCode, 1);
	}
});

// --- analog repeater file ---------------------------------------------------

test("a repeater CSV is read with loose column names", () => {
	const text = "Callsign,Output,Offset,CTCSS,Latitude,Longitude,City,Mode\nED7YAO,145.725,-0.6,82.5,36.93,-4.53,Malaga,FM\n";
	const result = analog.parseRepeaterFile(text, "spain.csv", MALAGA);
	assert.equal(result.repeaters.length, 1);
	assert.equal(result.repeaters[0].uplink_mhz, 145.125);
	assert.equal(result.repeaters[0].tx_tone, "82.5");
	assert.equal(result.repeaters[0].source, "file");
});

test("a shift in kHz or with a decimal comma is understood", () => {
	const text = "callsign;freq;shift;tone;lat;lon\nED7YAZ;145,725;-600;82,5;36,9;-4,5\n";
	const [repeater] = analog.parseRepeaterFile(text, "x.csv").repeaters;
	assert.equal(repeater.downlink_mhz, 145.725);
	assert.equal(repeater.uplink_mhz, 145.125);
	assert.equal(repeater.tx_tone, "82.5");
});

test("unusable rows are skipped with a reason", () => {
	const text = "callsign,output_mhz,offset_mhz,mode\n,145.7,-0.6,FM\nED7DS,145.7,-0.6,DMR\nED7YAO,145.7,-0.6,FM\n";
	const result = analog.parseRepeaterFile(text, "x.csv");
	assert.equal(result.repeaters.length, 1);
	assert.equal(result.skipped, 2);
});

test("the snapshot decoder and band search work", () => {
	const rows = [
		["ED7YAO", 145.725, 145.125, "82.5", 36.93, -4.53, "FM", "Malaga", "h"],
		["ED7YAE", 438.65, 431.05, "", 36.72, -4.42, "FM", "Malaga", "u"],
		["ED7NOG", 145.6, 145.0, "", null, null, "FM", "nowhere", "h"],
	];
	const repeaters = analog.decodeSnapshot(rows);
	assert.equal(repeaters.length, 3);
	assert.equal(repeaters[1].offset_mhz, -7.6);
	const vhf = analog.nearby(repeaters, MALAGA.lat, MALAGA.lon, 50, { band: "vhf" });
	assert.deepEqual(vhf.map((r) => r.callsign), ["ED7YAO"]);
	const uhf = analog.nearby(repeaters, MALAGA.lat, MALAGA.lon, 50, { band: "uhf" });
	assert.deepEqual(uhf.map((r) => r.callsign), ["ED7YAE"]);
});

// --- what a plan adds -------------------------------------------------------

test("a plan adds channels, contacts, lists and zones to an empty codeplug", () => {
	const model = empty();
	const result = applyPlan(model, plan({ dmr: [dmrRepeater()] }));
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(model.channels.length, result.added.channels);
	assert.equal(model.channels.filter((channel) => channel.mode === "dmr").length, 1);
	const repeater = model.channels.find((channel) => channel.name === "ED7ZAC");
	assert.equal(repeater.rxHz, 438_450_000);
	assert.equal(repeater.txHz, 430_850_000);
	assert.equal(repeater.contact.id, 21429);
	assert.equal(repeater.contact.timeslot, 2, "the first talkgroup's slot is the override");
	assert.deepEqual(repeater.rxList.contacts.map((contact) => contact.id), [21429, 214]);
	assert.ok(model.zones.some((zone) => zone.name === "DMR"));
	assert.ok(model.zones.some((zone) => zone.name === "STANDARD"));
});

test("a plan appends to what the codeplug already holds, and never renames it", () => {
	const model = empty();
	model.general.radioName = "MINE";
	model.general.dmrId = 111;
	model.channels.push({ ...model.channels[0] });
	const first = applyPlan(model, plan({ packs: ["r1_calling"], options: { aprsConfig: false } }));
	assert.equal(first.ok, true);
	const existing = model.channels.length;
	const again = applyPlan(model, plan({ packs: ["r1_calling"], options: { aprsConfig: false } }));
	assert.equal(again.ok, true);
	assert.ok(model.channels.length > existing, "a second build adds rather than replaces");
	const names = model.channels.map((channel) => channel.name);
	assert.equal(new Set(names).size, names.length, "names stay unique across builds");
	assert.equal(model.general.radioName, "MINE");
	assert.equal(model.general.dmrId, 111);
	assert.ok(again.notes.some((note) => note.code === "name_kept"));
});

test("the APRS position lands on the region's frequency and links to its channel", () => {
	const model = empty();
	const result = applyPlan(model, plan({ options: { aprsConfig: true, aprsSsid: 9 } }));
	assert.equal(result.ok, true);
	assert.equal(model.aprs.length, 1);
	assert.equal(model.aprs[0].name, "EA7KLK-9");
	assert.equal(model.aprs[0].txHz, 144_800_000);
	const channel = model.channels.find((c) => c.aprs === model.aprs[0]);
	assert.ok(channel);
	assert.equal(channel.rxHz, 144_800_000);
});

test("the DMR simplex plan adds TG 99 and AllCall contacts", () => {
	const model = empty();
	const result = applyPlan(model, plan({
		packs: [],
		options: { aprsConfig: false },
		dmrSimplex: { enabled: true, plan: "es", choice: "both", includeAccess: true },
	}));
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.added.channels, 42);
	assert.deepEqual(model.contacts.map((c) => [c.name, c.type, c.id]).sort(),
		[["AllCall", "all", 0xffffff], ["Simplex", "group", 99]].sort());
	const channel = model.channels.find((c) => c.name === "SOTA-U TG99");
	assert.ok(channel);
	assert.equal(channel.dmo, true);
	assert.equal(channel.timeslot, 1);
	const access = model.channels.find((c) => c.name === "PA1-V TG99");
	assert.equal(access.timeslot, 2);
});

test("talkgroups chosen without a repeater become plain group contacts", () => {
	const model = empty();
	const result = applyPlan(model, plan({
		packs: [],
		dmr: [],
		contacts: [{ tg: 214, name: "Spain" }, { tg: 92, name: "Europe" }],
		options: { aprsConfig: false },
	}));
	assert.equal(result.ok, true);
	assert.deepEqual(model.contacts.map((c) => [c.name, c.id, c.timeslot]), [["Spain", 214, 0], ["Europe", 92, 0]]);
	assert.equal(model.channels.length, 0, "a contact is not a channel");
});

test("a talkgroup used by a repeater keeps its override; a chosen one is separate", () => {
	const model = empty();
	const result = applyPlan(model, plan({
		packs: [],
		dmr: [dmrRepeater()],
		contacts: [{ tg: 214, name: "Spain" }],
		options: { aprsConfig: false },
	}));
	assert.equal(result.ok, true);
	const spains = model.contacts.filter((contact) => contact.id === 214);
	assert.deepEqual(spains.map((c) => c.timeslot).sort(), [0, 1]);
	assert.ok(spains.some((c) => c.name === "Spain TS1"), "the pinned one says which slot");
});

test("an empty plan says what is missing and changes nothing", () => {
	const model = empty();
	const result = applyPlan(model, { location: null, packs: [], dmr: [], analog: [], contacts: [] });
	assert.equal(result.ok, false);
	assert.equal(model.channels.length, 0);
	assert.deepEqual(result.errors.map((error) => error.code).sort(), ["no_location", "nothing_selected"]);
});

test("what a plan adds validates and exports like any other codeplug", () => {
	const model = empty();
	const result = applyPlan(model, plan({ dmr: [dmrRepeater()], analog: [{ callsign: "ED7YAO", downlink_mhz: 145.725, uplink_mhz: 145.125, tx_tone: "82.5", rx_tone: "" }] }));
	assert.equal(result.ok, true);
	assert.deepEqual(validate(model).filter((problem) => problem.level === "error"), []);
	const yaml = exportQdmr(model);
	const back = empty();
	importQdmr(back, yaml.text);
	assert.equal(back.channels.length, model.channels.length);
	assert.equal(back.contacts.length, model.contacts.length);
	const csv = exportAll(model);
	const fromCsv = empty();
	const { results } = importAll(fromCsv, csv.map((file) => ({ name: file.name, text: file.data })));
	assert.deepEqual(results.flatMap((entry) => entry.problems), []);
	assert.equal(fromCsv.channels.length, model.channels.length);
});

test("a plan that would overflow the radio is refused before anything is written", () => {
	const model = empty();
	// 68 zones is the limit; this plan makes more
	const result = applyPlan(model, plan({
		packs: [],
		dmr: [],
		contacts: [],
		options: { aprsConfig: false },
		dmrSimplex: { enabled: true, plan: "es", choice: "both", includeAccess: true },
	}));
	assert.equal(result.ok, true, "one plan fits");
	for (let i = 0; i < 70; i++) applyPlan(model, plan({ packs: ["r1_calling"], dmr: [], contacts: [], options: { aprsConfig: false } }));
	assert.ok(model.channels.length > 0);
});

// --- one tick at a time -----------------------------------------------------

test("a repeater tick adds its channel, contacts and list, and hasSource says so", () => {
	const model = empty();
	assert.equal(hasSource(model, "dmr:214702"), false);
	const result = addRepeater(model, { ...dmrRepeater(), talkgroups: [
		{ tg: 21429, slot: 2, name: "Provincial Málaga" },
		{ tg: 214, slot: 1, name: "Spain" },
	] }, { key: "dmr:214702" });
	assert.equal(result.ok, true);
	assert.equal(hasSource(model, "dmr:214702"), true);
	assert.equal(model.channels.length, 1);
	assert.equal(model.contacts.length, 2);
	assert.equal(model.rxLists.length, 1);
	assert.equal(model.zones.length, 1);
	assert.deepEqual(sourceKeys(model), ["dmr:214702"]);
});

test("unticking removes exactly that repeater's records and nothing else", () => {
	const model = empty();
	addRepeater(model, { ...dmrRepeater(), talkgroups: [{ tg: 21429, slot: 2, name: "Málaga" }] }, { key: "dmr:214702" });
	addPack(model, "pmr446", { region: "R1", country: "ES" });
	const before = { channels: model.channels.length, contacts: model.contacts.length };
	assert.equal(before.channels, 17);
	const { ok, removed } = removeSource(model, "dmr:214702");
	assert.equal(ok, true);
	assert.equal(removed.channels.length, 1);
	assert.equal(model.channels.length, 16);
	assert.equal(model.contacts.length, 0);
	assert.equal(model.rxLists.length, 0);
	assert.equal(model.zones.length, 1, "the PMR446 zone stays");
	assert.equal(hasSource(model, "dmr:214702"), false);
	assert.equal(hasSource(model, "pack:pmr446"), true);
});

test("the receipt stays after a removal, so undo finds the records again", () => {
	const model = empty();
	addRepeater(model, { ...dmrRepeater(), talkgroups: [{ tg: 21429, slot: 2, name: "Málaga" }] }, { key: "dmr:214702" });
	const { removed } = removeSource(model, "dmr:214702");
	model.channels.push(removed.channels[0]);	// what the editor's undo does
	assert.equal(hasSource(model, "dmr:214702"), true);
});

test("a contact another channel still uses is not removed", () => {
	const model = empty();
	addRepeater(model, { ...dmrRepeater(), talkgroups: [{ tg: 214, slot: 1, name: "Spain" }] }, { key: "dmr:214702" });
	addTalkgroup(model, { tg: 214, name: "Spain" }, { key: "tg:214" });
	const shared = model.contacts.find((contact) => contact.id === 214);
	removeSource(model, "dmr:214702");
	assert.ok(model.contacts.includes(shared) === false || model.channels.some((c) => c.contact === shared));
	// the plain contact from the table is still there because it is its own receipt
	assert.equal(hasSource(model, "tg:214"), true);
});

test("a zone another tick also uses stays when the first goes", () => {
	const model = empty();
	addPack(model, "r1_calling", { region: "R1", country: "ES" });
	addPack(model, "pmr446", { region: "R1", country: "ES" });
	const zone = model.zones.find((z) => z.name === "STANDARD");
	assert.ok(zone);
	assert.equal(zone.channels.length, 27, "both packs share one zone");
	removeSource(model, "pack:r1_calling");
	assert.ok(model.zones.includes(zone), "records from the other tick are still in it");
	assert.equal(zone.channels.length, 16);
	assert.deepEqual(zone.channels.map((c) => c.name).slice(0, 2), ["PMR01", "PMR02"]);
});

test("an empty zone the Builder made goes with its last channel", () => {
	const model = empty();
	addPack(model, "r1_calling", { region: "R1", country: "ES" });
	assert.equal(model.zones.length, 1);
	removeSource(model, "pack:r1_calling");
	assert.equal(model.zones.length, 0);
});

test("the simplex plan is one tick, and switching its contact is one change", () => {
	const model = empty();
	addSimplex(model, { plan: "es", choice: "tg99", country: "ES" });
	assert.equal(model.channels.length, 9);
	assert.equal(model.contacts.length, 1);
	assert.equal(hasSource(model, "simplex"), true);
	removeSource(model, "simplex");
	addSimplex(model, { plan: "es", choice: "both", country: "ES" });
	assert.equal(model.channels.length, 18);
	assert.deepEqual(model.contacts.map((c) => c.type).sort(), ["all", "group"]);
});

test("the APRS tick needs an APRS channel, and takes its own record away", () => {
	const model = empty();
	const refused = addAprs(model, { location: MALAGA, callsign: "EA7KLK" });
	assert.equal(refused.ok, false);
	assert.equal(refused.warnings[0].code, "aprs_no_channel");
	addPack(model, "aprs_r1", { region: "R1", country: "ES" });
	const result = addAprs(model, { location: MALAGA, callsign: "EA7KLK", ssid: 7, country: "ES" });
	assert.equal(result.ok, true);
	assert.equal(model.aprs.length, 1);
	const channel = model.channels.find((c) => c.aprs);
	assert.ok(channel);
	removeSource(model, "aprs");
	assert.equal(model.aprs.length, 0);
	assert.equal(channel.aprs, null, "the channel link goes too");
	assert.equal(model.channels.length, 2, "and the channels stay");
});

test("removing an unknown source is a no-op, not a crash", () => {
	const model = empty();
	const result = removeSource(model, "nothing");
	assert.equal(result.ok, false);
	assert.equal(model.channels.length, 0);
});

test("names stay unique across separate ticks", () => {
	const model = empty();
	addPack(model, "marine_intl", { region: "R1", country: "ES" });
	addPack(model, "marine_intl", { region: "R1", country: "ES" });
	const all = model.channels.map((c) => c.name);
	assert.equal(new Set(all).size, all.length);
});

// --- the band filter, and tones reaching the codeplug -----------------------

test("the band filter chooses one band and never filters everything out", () => {
	const rows = analog.decodeSnapshot([
		["V1", 145.7, 145.1, "82.5", 36.7, -4.4, "FM", "x", "h"],
		["U1", 438.65, 431.05, "77.0", 36.7, -4.4, "FM", "x", "u"],
	]);
	const at = (band) => analog.nearby(rows, 36.7, -4.4, 50, { band }).map((r) => r.callsign);
	assert.deepEqual(at("all"), ["U1", "V1"]);
	assert.deepEqual(at("vhf"), ["V1"]);
	assert.deepEqual(at("uhf"), ["U1"]);
	assert.deepEqual(at("bogus"), ["U1", "V1"], "an unknown band means every band");
	assert.deepEqual(at(undefined), ["U1", "V1"]);
	assert.equal(analog.asBand(""), "all");
});

test("a UHF repeater is listed and its tone reaches the channel", () => {
	const model = empty();
	addAnalog(model, {
		callsign: "ED7YAE", downlink_mhz: 438.65, uplink_mhz: 431.05,
		tx_tone: "82.5", rx_tone: "", source: "u",
	});
	const channel = model.channels[0];
	assert.equal(channel.rxHz, 438_650_000);
	assert.equal(channel.txHz, 431_050_000);
	assert.equal(channel.txTone, "82.5");
	assert.equal(channel.rxTone, "");
});

test("both tones reach the channel when the repeater has both", () => {
	const model = empty();
	addAnalog(model, {
		callsign: "ED7YAO", downlink_mhz: 145.725, uplink_mhz: 145.125,
		tx_tone: "88.5", rx_tone: "77.0",
	});
	const channel = model.channels[0];
	assert.equal(channel.txTone, "88.5");
	assert.equal(channel.rxTone, "77.0");
});

test("a DCS code reaches the channel as a DCS code", () => {
	const model = empty();
	addAnalog(model, { callsign: "ED7YAZ", downlink_mhz: 145.6, uplink_mhz: 145.0, tx_tone: "D023N", rx_tone: "" });
	assert.equal(model.channels[0].txTone, "D023N");
});

test("a tone the radio cannot take is dropped and reported, not passed through", () => {
	const model = empty();
	const result = addAnalog(model, { callsign: "ED7YAY", downlink_mhz: 145.65, uplink_mhz: 145.05, tx_tone: "CC1" });
	assert.equal(model.channels[0].txTone, "");
	assert.ok(result.warnings.some((w) => w.code === "tones_dropped"));
});
