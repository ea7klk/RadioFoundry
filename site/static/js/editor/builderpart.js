// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Copyright (c) 2026 The RadioFoundry-cp-builder Authors
// The Builder tab: channels, contacts and zones built from a location. It asks
// for a place, offers the standard analog packs, the DMR repeaters and their
// static talkgroups, a searchable table of every Brandmeister talkgroup, the
// analog repeaters and the DMR simplex plan.
//
// Every tick of a box changes the open codeplug at once — the channel, contact,
// RX group list or zone appears in its own tab — and every tick is its own
// change, so Undo takes back exactly that one. Unticking takes exactly that
// source's records away again and leaves anything else still using them.
//
// Everything runs in the page. The repeater and talkgroup lists are the
// snapshots in codeplug/builder/data/ (Brandmeister and HearHam send no CORS
// headers, so a page cannot read them); place search and geolocation are live.
// The choices are kept in this browser, never sent anywhere.

import { register } from "./extensions.js";
import { h, button } from "../flasher/dom.js";
import {
	asciiName, problemText, applyStation,
	addRepeater, addAnalog, addPack, addTalkgroup, addSimplex, addAprs,
	removeSource, hasSource, sourceKeys,
} from "../codeplug/builder/plan.js";
import { LIMITS } from "../codeplug/records.js";
import * as geo from "../codeplug/builder/geo.js";
import * as packs from "../codeplug/builder/packs.js";
import { LANG } from "../i18n.js";
import * as dmr from "../codeplug/builder/dmr.js";
import * as analog from "../codeplug/builder/analog.js";
import { validate } from "../codeplug/model.js";

const PREFS = "rfoundry-editor-builder";
const GEOCODE_CACHE = "rfoundry-editor-builder-geocode";
const GEOCODE_TTL = 30 * 24 * 3600 * 1000;	// Nominatim's policy asks clients to cache

const DEFAULTS = {
	location: null,		// {lat, lon, label}
	country: "ES",
	region: "R1",
	radius: 50,
	band: "all",		// analog band filter
	tgQuery: "",
	tgContinent: "all",
	tgCountry: "",
	station: { callsign: "", dmrId: "", ssid: 7 },
	options: { aprsConfig: true, fallbackTg: true },
	simplex: { enabled: false, choice: "tg99", includeAccess: false },
};

function load(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : JSON.parse(raw);
	} catch {
		return fallback;
	}
}

function store(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// storage blocked: the choices last for this visit only
	}
}

// One builder for the page's life, so selections and loaded lists survive a tab switch
const B = {
	prefs: { ...DEFAULTS, ...load(PREFS, {}) },
	api: null,
	el: null,
	P: null,		// the elements update() writes
	dmrRepeaters: null,	// the snapshot, decoded
	analogRepeaters: null,
	talkgroups: null,
	snapshot: null,		// {dmr: {fetched}, analog: {fetched}}
	file: [],		// repeaters from a file the user picked
	fileReport: null,
	built: null,
	loading: false,
};

const save = () => store(PREFS, B.prefs);

// A name from the catalogue, or the English the data carries when the catalog
// has no key for it. t() answers with the key itself when it cannot translate.
const label = (key, english) => {
	const text = B.api?.t(key);
	return !text || text === key ? english : text;
};

// A country's full name in the page's language, from the two-letter code the
// data carries; a code no one can name shows as the code.
const place = (cc) => packs.countryName(cc, LANG) || cc;

// A choice changed: keep it, then redraw. Module level, because update() and
// the handlers both call it.
const changed = () => {
	save();
	update();
};

register({
	builderTab(api) {
		B.api = api;
		if (!B.el) build(api);
		update();
		loadData();
		return B.el;
	},
});

// --- data -------------------------------------------------------------------

async function loadData() {
	if (B.loading) return;
	if (B.talkgroups && B.dmrRepeaters && B.analogRepeaters) {
		// already loaded: only the status line may still hold the loading text
		if (B.P.status.textContent === B.api.t("editor.builder.loading")) {
			B.P.status.textContent = B.api.t("editor.builder.loaded");
		}
		return;
	}
	B.loading = true;
	B.P.status.textContent = B.api.t("editor.builder.loading");
	try {
		const [tg, dmrRows, analogRows, meta] = await Promise.all([
			import("../codeplug/builder/data/talkgroups.js"),
			import("../codeplug/builder/data/dmr-repeaters.js"),
			import("../codeplug/builder/data/analog-repeaters.js"),
			import("../codeplug/builder/data/meta.js"),
		]);
		B.talkgroups = tg.TALKGROUPS;
		B.dmrRepeaters = dmrRows.DMR_REPEATERS.map((row) => ({
			id: row[0],
			callsign: row[1],
			downlink_mhz: row[2],
			uplink_mhz: row[3],
			color_code: row[4],
			lat: row[5],
			lon: row[6],
			city: row[7],
			status: row[8],
			talkgroups: (row[9] || []).map(([tgId, slot]) => ({ tg: tgId, slot })),
		}));
		B.analogRepeaters = analog.decodeSnapshot(analogRows.ANALOG_REPEATERS);
		B.snapshot = {
			dmr: dmrRows.FETCHED_AT,
			analog: analogRows.FETCHED_AT,
			sources: meta.SOURCES || [],
		};
		B.P.status.textContent = B.api.t("editor.builder.loaded");
		update();
	} catch (error) {
		B.P.status.textContent = B.api.t("editor.builder.load_failed", { error: String(error.message || error) });
	} finally {
		B.loading = false;
	}
}

// Brandmeister's talkgroup names come with the list; a fallback keeps a
// contact readable if the snapshot ever lacks one.
function talkgroupName(tg) {
	const found = B.talkgroups?.find((row) => row[0] === Number(tg));
	return found ? found[1] : `TG ${tg}`;
}

// A repeater's own static talkgroups are not published in bulk, and fetching
// one per repeater is throttled to the point of taking days for the whole list.
// So a repeater whose list the snapshot does not hold falls back to its
// country's national talkgroup, read from the same table: Brandmeister builds
// both ids on the ITU prefix, so repeater 214702 is in Spain and talkgroup 214
// is Spain. Nothing is invented; when the table has no such talkgroup the plan
// falls back to TG 9.
function nationalTalkgroup(repeater) {
	const prefix = Number(String(repeater.id).slice(0, 3));
	if (!(prefix >= 100)) return null;
	const found = B.talkgroups?.find((row) => row[0] === prefix);
	return found ? { tg: found[0], slot: 0, name: found[1], national: true } : null;
}

// The talkgroups a repeater channel is built on: its own, or its country's.
function repeaterTalkgroups(repeater) {
	if (repeater.talkgroups.length) return repeater.talkgroups.map((tg) => ({ ...tg, name: talkgroupName(tg.tg) }));
	const national = nationalTalkgroup(repeater);
	return national ? [national] : [];
}

// --- building the tab -------------------------------------------------------

function build(api) {
	const { t } = api;
	const P = (B.P = {});
	const field = (label, input, help) => h("label", { class: "rid-field" },
		h("span", {}, label), input, help ? h("span", { class: "small muted" }, help) : null);
	const step = (n, title, ...body) => h("section", { class: "rid-step" },
		h("h3", {}, h("span", { class: "rid-n" }, String(n)), title), ...body);
	const card = (...children) => h("div", { class: "rid-grid" }, ...children);

	// 1. Location
	P.lat = h("input", { type: "text", inputmode: "decimal", placeholder: "36.72130", value: B.prefs.location?.lat ?? "",
		oninput: () => {} });
	P.lon = h("input", { type: "text", inputmode: "decimal", placeholder: "-4.42140", value: B.prefs.location?.lon ?? "",
		oninput: () => {} });
	P.locator = h("input", { type: "text", placeholder: "IM76SR", maxlength: "8", oninput: () => {} });
	P.city = h("input", { type: "search", placeholder: t("editor.builder.city_placeholder"),
		onkeydown: (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				searchCity();
			}
		} });
	P.cityResults = h("div", { class: "rid-row", hidden: true });
	P.location = h("p", { class: "small muted" });
	const useLatLon = () => {
		const lat = Number(P.lat.value);
		const lon = Number(P.lon.value);
		if (!geo.validLat(lat) || !geo.validLon(lon)) return api.say(t("editor.builder.bad_coords"), "bad");
		setLocation({ lat, lon, label: t("editor.builder.coords") });
	};
	const useLocator = () => {
		const point = geo.locatorToLatLon(P.locator.value);
		if (!point) return api.say(t("editor.builder.bad_locator"), "bad");
		setLocation({ ...point, label: P.locator.value.trim().toUpperCase() });
	};
	P.useHere = button(t("editor.builder.use_here"), () => {
		if (!navigator.geolocation) return api.say(t("editor.builder.no_geolocation"), "bad");
		P.useHere.disabled = true;
		navigator.geolocation.getCurrentPosition((pos) => {
			P.useHere.disabled = false;
			setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: t("editor.builder.here") });
		}, (error) => {
			P.useHere.disabled = false;
			api.say(t("editor.builder.geolocation_failed", { code: String(error.code) }), "bad");
		}, { timeout: 12000, maximumAge: 600000 });
	}, { quiet: true });
	const findCity = button(t("editor.builder.find"), () => searchCity(), { quiet: true });

	// 2. Standard channels
	P.country = h("select", { onchange: () => {
		B.prefs.country = P.country.value;
		if (B.prefs.country) B.prefs.region = packs.regionForCountry(B.prefs.country);
		changed();
	} });
	P.region = h("select", { onchange: () => {
		B.prefs.region = P.region.value;
		changed();
	} });
	P.packList = h("div", { class: "ed-builder-packs" });
	P.aprs = h("input", { type: "checkbox", onchange: () => {
		B.prefs.options.aprsConfig = P.aprs.checked;
		save();
		tickAprs();
	} });
	P.ssid = h("input", { type: "text", inputmode: "numeric", maxlength: "2", value: String(B.prefs.station.ssid),
		oninput: () => {
			B.prefs.station.ssid = Math.max(0, Math.min(15, Number(P.ssid.value) || 0));
			changed();
		} });
	P.packsNote = h("p", { class: "small muted" });

	// 3. DMR repeaters
	P.dmrRadius = h("input", { type: "range", min: "5", max: "300", step: "5", value: String(B.prefs.radius),
		oninput: () => {
			B.prefs.radius = Number(P.dmrRadius.value);
			P.dmrRadiusOut.textContent = t("editor.builder.km", { km: B.prefs.radius });
			changed();
		} });
	P.dmrRadiusOut = h("output", {}, t("editor.builder.km", { km: B.prefs.radius }));
	P.dmrRows = h("tbody");
	P.snapshotNote = h("p", { class: "small muted" });
	P.dmrStatus = h("p", { class: "small muted" });
	P.fallback = h("input", { type: "checkbox", checked: B.prefs.options.fallbackTg, onchange: () => {
		B.prefs.options.fallbackTg = P.fallback.checked;
		changed();
	} });

	// 4. Talkgroup table
	P.tgQuery = h("input", { type: "search", placeholder: t("editor.builder.tg_placeholder"), value: B.prefs.tgQuery,
		onkeydown: (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				B.prefs.tgQuery = P.tgQuery.value.trim();
				changed();
			}
		} });
	P.tgContinent = h("select", { onchange: () => {
		B.prefs.tgContinent = P.tgContinent.value;
		B.prefs.tgCountry = "";
		changed();
	} });
	P.tgCountry = h("select", { onchange: () => {
		B.prefs.tgCountry = P.tgCountry.value;
		changed();
	} });
	P.tgSearch = button(t("editor.builder.search"), () => {
		B.prefs.tgQuery = P.tgQuery.value.trim();
		changed();
	}, { quiet: true });
	P.tgRows = h("tbody");
	P.tgStatus = h("p", { class: "small muted" });
	P.tgAll = h("input", { type: "checkbox", "aria-label": t("editor.builder.select_all"), onchange: () => {
		const rows = visibleTalkgroups().slice(0, 250);
		const want = rows.filter((row) => hasSource(B.api.model, `tg:${row[0]}`)).length !== rows.length;
		applyChange(B.api.t("editor.builder.select_all"), () => {
			withStation(B.api.model);
			for (const row of rows) {
				const key = `tg:${row[0]}`;
				if (want && !hasSource(B.api.model, key)) addTalkgroup(B.api.model, { tg: row[0], name: row[1] }, { key });
				if (!want && hasSource(B.api.model, key)) removeSource(B.api.model, key);
			}
			return { ok: true };
		});
		update();
	} });
	P.tgChips = h("ul", { class: "rid-chips" });
	P.tgCount = h("span", { class: "badge" });

	// 5. Analog repeaters
	P.analogRadius = h("input", { type: "range", min: "5", max: "300", step: "5", value: String(B.prefs.radius),
		oninput: () => {
			B.prefs.radius = Number(P.analogRadius.value);
			P.analogRadiusOut.textContent = t("editor.builder.km", { km: B.prefs.radius });
			changed();
		} });
	P.analogRadiusOut = h("output", {}, t("editor.builder.km", { km: B.prefs.radius }));
	// The band filter: VHF below 300 MHz, UHF above it. The options are built
	// here, not in update(), so the control keeps them across redraws.
	P.band = h("select", { onchange: () => {
		B.prefs.band = P.band.value;
		changed();
	} },
	h("option", { value: "all" }, t("editor.builder.band_all")),
	h("option", { value: "vhf" }, t("editor.builder.band_vhf")),
	h("option", { value: "uhf" }, t("editor.builder.band_uhf")));
	P.analogRows = h("tbody");
	P.analogStatus = h("p", { class: "small muted" });
	P.fileOutput = h("div", {});
	P.filePicker = h("input", { type: "file", accept: ".csv,.txt,.json", onchange: async () => {
		const picked = P.filePicker.files?.[0];
		P.filePicker.value = "";
		if (!picked) return;
		const parsed = analog.parseRepeaterFile(await picked.text(), picked.name, B.prefs.location);
		B.file = parsed.repeaters;
		B.fileReport = parsed;
		changed();
	} });

	// 6. DMR simplex
	P.simplexOn = h("input", { type: "checkbox", onchange: () => {
		B.prefs.simplex.enabled = P.simplexOn.checked;
		save();
		tickSimplex();
	} });
	P.simplexChoice = h("div", { class: "choice-grid ed-builder-simplex" });
	P.simplexAccess = h("input", { type: "checkbox", onchange: () => {
		B.prefs.simplex.includeAccess = P.simplexAccess.checked;
		save();
		if (hasSource(B.api.model, "simplex")) chooseSimplex(B.prefs.simplex.choice);
		else update();
	} });

	// 7. Station
	P.callsign = h("input", { type: "text", maxlength: "12", value: B.prefs.station.callsign, onchange: () => {
		B.prefs.station.callsign = P.callsign.value.toUpperCase().replace(/[^A-Z0-9/]/g, "");
		P.callsign.value = B.prefs.station.callsign;
		save();
		applyStationFields();
	} });
	P.dmrId = h("input", { type: "text", inputmode: "numeric", maxlength: "8", value: B.prefs.station.dmrId,
		onchange: () => {
			B.prefs.station.dmrId = P.dmrId.value.replace(/[^0-9]/g, "");
			P.dmrId.value = B.prefs.station.dmrId;
			save();
			applyStationFields();
		} });

	// Output. There is no "add" button: every tick adds or removes its own
	// records, and each is one change the editor can undo on its own.
	P.clear = button(t("editor.builder.clear"), () => clearAll(), { quiet: true });
	P.status = h("p", { class: "small muted" });
	P.output = h("div", { class: "ed-builder-output" });

	// The banner: what the tab does, then the two things to do after it, each in
	// its own box so none of them reads as fine print.
	const note = (tone, titleKey, textKey) => h("div", { class: `ed-builder-note ${tone}` },
		h("h3", {}, t(titleKey)), h("p", {}, t(textKey)));

	P.el = h("div", { class: "rid ed-builder" },
		h("div", { class: "ed-builder-intro" }, h("p", { class: "lead" }, t("editor.builder.lead"))),
		note("warn", "editor.builder.note_power_title", "editor.builder.note_power"),
		note("info", "editor.builder.note_zones_title", "editor.builder.note_zones"),
		step(1, t("editor.builder.s1"),
			card(field(t("editor.builder.lat"), P.lat), field(t("editor.builder.lon"), P.lon),
				field(t("editor.builder.locator"), P.locator)),
			h("div", { class: "rid-row" },
				button(t("editor.builder.use_coords"), useLatLon, { quiet: true }),
				button(t("editor.builder.use_locator"), useLocator, { quiet: true }),
				P.useHere),
			h("div", { class: "rid-row" },
				field(t("editor.builder.city"), P.city), findCity),
			P.cityResults,
			P.location),
		step(2, t("editor.builder.s2"),
			card(field(t("editor.builder.country"), P.country), field(t("editor.builder.region"), P.region)),
			P.packList,
			h("div", { class: "rid-row" },
				h("label", { class: "rid-check" }, P.aprs, h("span", {}, t("editor.builder.aprs"))),
				field(t("editor.builder.ssid"), P.ssid)),
			P.packsNote),
		step(3, t("editor.builder.s3"),
			h("div", { class: "rid-row" },
				field(t("editor.builder.radius"), P.dmrRadius), P.dmrRadiusOut),
			P.dmrStatus,
			(P.dmrWrap = h("div", { class: "table-wrap ed-builder-table" },
				h("table", { class: "grid" },
					h("thead", {}, h("tr", {},
						h("th", { class: "grid-check" }, ""), h("th", {}, t("editor.builder.col_call")),
						h("th", {}, t("editor.builder.col_dmx")), h("th", {}, t("editor.builder.col_place")),
						h("th", {}, t("editor.builder.col_tg")))),
					P.dmrRows))),
			h("label", { class: "rid-check" }, P.fallback, h("span", {}, t("editor.builder.fallback"))),
			h("p", { class: "small muted" }, t("editor.builder.s3_note")),
			P.snapshotNote),
		step(4, t("editor.builder.s4"),
			card(field(t("editor.builder.tg_search"), P.tgQuery), field(t("editor.builder.continent"), P.tgContinent),
				field(t("editor.builder.country"), P.tgCountry)),
			h("div", { class: "rid-row" }, P.tgSearch, P.tgCount),
			P.tgStatus,
			(P.tgWrap = h("div", { class: "table-wrap ed-builder-table" },
				h("table", { class: "grid" },
					h("thead", {}, h("tr", {},
						h("th", { class: "grid-check" }, P.tgAll), h("th", {}, t("editor.builder.col_tg_id")),
						h("th", {}, t("editor.builder.col_name")), h("th", {}, t("editor.builder.col_country")))),
					P.tgRows))),
			P.tgChips,
			h("p", { class: "small muted" }, t("editor.builder.s4_note"))),
		step(5, t("editor.builder.s5"),
			h("div", { class: "rid-row" }, field(t("editor.builder.band"), P.band),
				field(t("editor.builder.radius"), P.analogRadius), P.analogRadiusOut),
			P.analogStatus,
			(P.analogWrap = h("div", { class: "table-wrap ed-builder-table" },
				h("table", { class: "grid" },
					h("thead", {}, h("tr", {},
						h("th", { class: "grid-check" }, ""), h("th", {}, t("editor.builder.col_call")),
						h("th", {}, t("editor.builder.col_rx")), h("th", {}, t("editor.builder.col_tone")),
						h("th", {}, t("editor.builder.col_place")), h("th", {}, t("editor.builder.col_source")))),
					P.analogRows))),
			h("div", { class: "rid-row" },
				h("label", { class: "rid-field" }, h("span", {}, t("editor.builder.file")), P.filePicker)),
			P.fileOutput,
			h("p", { class: "small muted" }, t("editor.builder.s5_note"))),
		step(6, t("editor.builder.s6"),
			h("label", { class: "rid-check" }, P.simplexOn, h("span", {}, t("editor.builder.simplex_add"))),
			P.simplexChoice,
			h("label", { class: "rid-check" }, P.simplexAccess, h("span", {}, t("editor.builder.simplex_access"))),
			h("p", { class: "small muted" }, t("editor.builder.s6_note"))),
		step(7, t("editor.builder.s7"),
			card(field(t("editor.builder.callsign"), P.callsign, t("editor.builder.callsign_help")),
				field(t("editor.builder.dmr_id"), P.dmrId))),
		h("div", { class: "rid-output" }, h("div", { class: "rid-row" }, P.clear, P.status), P.output),
	);
	syncInputs();
	B.el = P.el;
	return B.el;
}

// The snapshot's talkgroup names are not in the talkgroup table's order, so a
// name is looked up once the snapshot has loaded.
function fillCountrySelect() {
	const P = B.P;
	const current = B.prefs.country;
	P.country.replaceChildren(
		h("option", { value: "" }, B.api.t("editor.builder.other_country")),
		...["R1", "R2", "R3"].map((region) => h("optgroup", { label: label(`editor.builder.region_${region.toLowerCase()}`, packs.REGIONS[region].label) },
			...packs.COUNTRIES.filter(([, , ccRegion]) => ccRegion === region)
				.map(([cc]) => h("option", { value: cc }, `${packs.countryName(cc, LANG)} (${cc})`)))));
	P.country.value = packs.COUNTRY_BY_CC.has(current) ? current : "";
	P.region.replaceChildren(...Object.entries(packs.REGIONS).map(([id, region]) =>
		h("option", { value: id }, label(`editor.builder.region_${id.toLowerCase()}`, region.label))));
	P.region.value = B.prefs.region;
}

function setLocation(location) {
	B.prefs.location = { lat: Math.round(location.lat * 1e6) / 1e6, lon: Math.round(location.lon * 1e6) / 1e6, label: location.label };

	syncInputs();
	save();
	update();
}

function syncInputs() {
	const P = B.P;
	if (!P) return;
	const { location } = B.prefs;
	P.lat.value = location ? location.lat.toFixed(5) : "";
	P.lon.value = location ? location.lon.toFixed(5) : "";
	P.locator.value = location ? geo.latLonToLocator(location.lat, location.lon, 6) : "";
	P.aprs.checked = B.prefs.options.aprsConfig;
	P.ssid.value = String(B.prefs.station.ssid);
	P.dmrRadius.value = String(B.prefs.radius);
	P.analogRadius.value = String(B.prefs.radius);
	P.dmrRadiusOut.textContent = B.api.t("editor.builder.km", { km: B.prefs.radius });
	P.analogRadiusOut.textContent = B.api.t("editor.builder.km", { km: B.prefs.radius });
	if (!["all", "vhf", "uhf"].includes(B.prefs.band)) B.prefs.band = "all";
	P.band.value = B.prefs.band;
	P.simplexOn.checked = B.prefs.simplex.enabled;
	P.simplexAccess.checked = B.prefs.simplex.includeAccess;
	P.callsign.value = B.prefs.station.callsign;
	P.dmrId.value = B.prefs.station.dmrId;
	P.tgQuery.value = B.prefs.tgQuery;
	fillCountrySelect();
}

// --- city search ------------------------------------------------------------

async function searchCity() {
	const query = B.P.city.value.trim();
	if (query.length < 2) return B.api.say(B.api.t("editor.builder.city_short"), "bad");
	B.P.cityResults.hidden = true;
	let results = cachedGeocode(query);
	if (!results) {
		const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&q=" + encodeURIComponent(query);
		try {
			const response = await fetch(url, { headers: { Accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			results = await response.json();
		} catch (error) {
			return B.api.say(B.api.t("editor.builder.city_failed"), "bad");
		}
		cacheGeocode(query, results);
	}
	const rows = results.slice(0, 6).map((place) => {
		const label = String(place.display_name || place.name || "").slice(0, 120);
		return h("button", { type: "button", class: "btn", onclick: () => {
			const cc = String(place.address?.country_code || "").toUpperCase();
			if (cc && packs.COUNTRY_BY_CC.has(cc)) {
				B.prefs.country = cc;
				B.prefs.region = packs.regionForCountry(cc);
			}
			B.P.cityResults.hidden = true;
			B.P.city.value = "";
			setLocation({ lat: Number(place.lat), lon: Number(place.lon), label: String(place.name || label) });
		} }, label);
	});
	B.P.cityResults.replaceChildren(...rows);
	B.P.cityResults.hidden = rows.length === 0;
	if (!rows.length) B.api.say(B.api.t("editor.builder.city_none"), "bad");
}

function cachedGeocode(query) {
	const cache = load(GEOCODE_CACHE, {});
	const entry = cache[query.toLowerCase()];
	return entry && Date.now() - entry.at < GEOCODE_TTL ? entry.results : null;
}

function cacheGeocode(query, results) {
	const cache = load(GEOCODE_CACHE, {});
	cache[query.toLowerCase()] = { at: Date.now(), results };
	const keys = Object.keys(cache);
	// keep the cache small: Nominatim asks for caching, not hoarding
	if (keys.length > 60) for (const key of keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 60)) delete cache[key];
	store(GEOCODE_CACHE, cache);
}

// --- rendering --------------------------------------------------------------

const analogKey = (repeater) => `${repeater.source || "h"}:${repeater.callsign}:${repeater.downlink_mhz}:${repeater.uplink_mhz}`;

// A table's rows are rebuilt only when what they show has changed. A tick
// changes one checkbox and nothing else, so rebuilding would throw the reader
// back to the top of the list and drop the focus they just used; the tick is
// applied in place instead. When a rebuild is needed, the scroll position is
// kept, so the list stays where the reader left it either way.
function syncRows(wrap, tbody, signature, rows, isOn) {
	if (tbody.dataset.sig !== signature || tbody.children.length !== rows.length) {
		const top = wrap.scrollTop;
		tbody.replaceChildren(...rows);
		tbody.dataset.sig = signature;
		wrap.scrollTop = top;
	}
	// Fresh rows are built checked-off; both paths take their state from the model
	for (let i = 0; i < tbody.children.length; i++) {
		const on = Boolean(isOn(i));
		const tr = tbody.children[i];
		tr.classList.toggle("selected", on);
		const box = tr.querySelector("input[type=checkbox]");
		if (box && box.checked !== on) box.checked = on;
	}
}

// Case and accents folded, so "malaga" finds "Provincial Málaga"
const foldText = (text) => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function visibleTalkgroups() {
	const needle = foldText(B.prefs.tgQuery).trim();
	const digits = B.prefs.tgQuery.replace(/[^0-9]/g, "");
	let rows = B.talkgroups || [];
	if (needle) {
		rows = rows.filter((row) =>
			foldText(row[1]).includes(needle) || (digits && String(row[0]).includes(digits)));
	}
	if (B.prefs.tgContinent !== "all") rows = rows.filter((row) => row[2] === B.prefs.tgContinent);
	if (B.prefs.tgCountry) rows = rows.filter((row) => row[3] === B.prefs.tgCountry);
	return rows;
}

function update() {
	const P = B.P;
	if (!P || !B.talkgroups) return;
	const { t } = B.api;
	const { location } = B.prefs;
	const model = B.api.model;

	P.location.replaceChildren(location
		? h("span", {}, `${location.label} · ${geo.formatLatLon(location.lat, location.lon, 4)} · ${geo.latLonToLocator(location.lat, location.lon, 6)}`)
		: h("span", {}, t("editor.builder.no_location")));

	// packs: a tick adds its channels now, and unticking takes them away
	P.packList.replaceChildren(...packs.PACKS.map((pack) => {
		const applies = packs.packApplies(pack, B.prefs.region, B.prefs.country);
		const count = pack.channels({ region: B.prefs.region, country: B.prefs.country }).length;
		const key = `pack:${pack.id}`;
		const box = h("input", { type: "checkbox", checked: hasSource(model, key), onchange: () => tickPack(pack, true) });
		return h("label", { class: "rid-check ed-builder-pack" }, box,
			h("span", {},
				h("strong", {}, pack.title), " ",
				h("span", { class: "badge" }, t("editor.builder.pack_channels", { n: count })),
				applies ? null : h("span", { class: "badge" }, t("editor.builder.other_region")),
				h("span", { class: "small muted ed-builder-pack-summary" }, pack.summary)));
	}));
	const aprsPack = packs.PACKS.some((pack) => pack.id.startsWith("aprs_") && hasSource(model, `pack:${pack.id}`));
	P.aprs.checked = hasSource(model, "aprs");
	P.aprs.disabled = !aprsPack;
	P.ssid.disabled = !aprsPack || !hasSource(model, "aprs");
	P.packsNote.textContent = aprsPack ? t("editor.builder.aprs_note") : t("editor.builder.aprs_note_off");

	// DMR repeaters
	let dmrRows = [];
	let dmrSig = "";
	const dmrIds = [];
	if (location && B.dmrRepeaters) {
		const near = B.dmrRepeaters
			.filter((repeater) => repeater.lat !== null && repeater.lon !== null)
			.map((repeater) => ({ ...repeater, km: geo.distanceKm(location.lat, location.lon, repeater.lat, repeater.lon) }))
			.filter((repeater) => repeater.km <= B.prefs.radius)
			.sort((a, b) => a.km - b.km)
			.slice(0, 300);
		const sig = [];
		for (const repeater of near) {
			const own = repeaterTalkgroups(repeater);
			const first = own[0];
			const tgText = first
				? (first.national
					? t("editor.builder.tg_national", { tg: first.tg, name: first.name })
					: `${first.tg}${first.slot ? ` · TS${first.slot}` : ""}`) + (own.length > 1 ? ` +${own.length - 1}` : "")
				: (B.prefs.options.fallbackTg ? t("editor.builder.tg_fallback") : "—");
			const freqs = `${geo.formatMHz(repeater.downlink_mhz * 1e6)} / ${geo.formatMHz(repeater.uplink_mhz * 1e6)}`;
			const place = `${repeater.city || "—"} · ${geo.formatKm(repeater.km)}`;
			sig.push(`${repeater.id}|${repeater.callsign}|${freqs}|${place}|${tgText}`);
			dmrRows.push(h("tr", {},
				h("td", { class: "grid-check" }, h("input", { type: "checkbox", onchange: () => tickRepeater(repeater) })),
				h("td", {}, repeater.callsign),
				h("td", { class: "c-num" }, freqs),
				h("td", {}, place),
				h("td", {}, tgText)));
		}
		dmrSig = sig.join("\n");
		for (const repeater of near) dmrIds.push(repeater.id);
		P.dmrStatus.textContent = near.length
			? t("editor.builder.dmr_found", { n: near.length, km: B.prefs.radius })
			: t("editor.builder.none_found");
	} else {
		P.dmrStatus.textContent = t("editor.builder.need_location");
	}
	syncRows(P.dmrWrap, P.dmrRows, dmrSig, dmrRows, (i) => hasSource(model, `dmr:${dmrIds[i]}`));

	// talkgroups
	const all = B.talkgroups || [];
	P.tgContinent.replaceChildren(h("option", { value: "all" }, t("editor.builder.all_continents")),
		...dmr.CONTINENTS.map(([id, english]) => h("option", { value: id }, label(`editor.builder.continent.${id}`, english))));
	P.tgContinent.value = B.prefs.tgContinent;
	const countries = new Map();
	for (const row of all) {
		if (row[3] && (B.prefs.tgContinent === "all" || row[2] === B.prefs.tgContinent))
			countries.set(row[3], (countries.get(row[3]) || 0) + 1);
	}
	P.tgCountry.replaceChildren(h("option", { value: "" }, t("editor.builder.all_countries")),
		...[...countries.entries()].sort((a, b) => a[0].localeCompare(b[0]))
			.map(([cc, n]) => h("option", { value: cc }, `${place(cc)} (${n})`)));
	P.tgCountry.value = countries.has(B.prefs.tgCountry) ? B.prefs.tgCountry : "";

	const visible = visibleTalkgroups();
	const shown = visible.slice(0, 250);
	const tgRows = [];
	const tgSig = [];
	const tgIds = [];
	for (const row of shown) {
		const [tgId, name, , cc] = row;
		const where = cc ? place(cc) : label(`editor.builder.continent.${row[2]}`, dmr.CONTINENT_LABEL[row[2]] || "");
		tgIds.push(tgId);
		tgSig.push(`${tgId}|${name}|${where}`);
		tgRows.push(h("tr", {},
			h("td", { class: "grid-check" }, h("input", {
				type: "checkbox", onchange: () => tickTalkgroup(tgId, name),
			})),
			h("td", { class: "c-num" }, String(tgId)),
			h("td", {}, name),
			h("td", {}, where)));
	}
	syncRows(P.tgWrap, P.tgRows, tgSig.join("\n"), tgRows, (i) => hasSource(model, `tg:${tgIds[i]}`));
	const chosenShown = shown.filter((row) => hasSource(model, `tg:${row[0]}`));
	P.tgAll.checked = shown.length > 0 && chosenShown.length === shown.length;
	P.tgAll.indeterminate = chosenShown.length > 0 && chosenShown.length < shown.length;
	P.tgStatus.textContent = visible.length
		? t("editor.builder.tg_matched", { n: visible.length, shown: shown.length })
		: t("editor.builder.tg_none");
	const chosenAll = (B.talkgroups || []).filter((row) => hasSource(model, `tg:${row[0]}`));
	P.tgCount.textContent = t("editor.builder.selected_n", { n: chosenAll.length });
	P.tgChips.replaceChildren(...chosenAll.map((row) => {
		const removeButton = h("button", { type: "button", "aria-label": t("editor.builder.remove", { name: row[1] }) });
		removeButton.textContent = "×";
		removeButton.addEventListener("click", () => tickTalkgroup(row[0], row[1]));
		return h("li", {}, h("b", {}, String(row[0])), " ", row[1], removeButton);
	}));

	// analog repeaters
	const pool = [...(B.analogRepeaters || []), ...B.file];
	const analogRows = [];
	const analogSig = [];
	const analogKeys = [];
	if (location) {
		const near = analog.nearby(pool, location.lat, location.lon, B.prefs.radius, { band: B.prefs.band, limit: 300 });
		for (const repeater of near) {
			const key = `analog:${analogKey(repeater)}`;
			const freqs = `${geo.formatMHz(repeater.downlink_mhz * 1e6)} / ${geo.formatMHz(repeater.uplink_mhz * 1e6)}`;
			const tone = repeater.tx_tone || t("editor.builder.no_tone");
			const place = `${repeater.city || "—"} · ${geo.formatKm(repeater.distance_km)} · ${analog.bandOf(repeater.downlink_mhz).toUpperCase()}`;
			const source = analog.SOURCE_NAMES[repeater.source] || repeater.source;
			analogKeys.push(key);
			analogSig.push(`${key}|${repeater.callsign}|${freqs}|${tone}|${place}|${source}`);
			analogRows.push(h("tr", {},
				h("td", { class: "grid-check" }, h("input", { type: "checkbox", onchange: () => tickAnalog(repeater) })),
				h("td", {}, repeater.callsign),
				h("td", { class: "c-num" }, freqs),
				h("td", {}, tone),
				h("td", {}, place),
				h("td", {}, source)));
		}
		P.analogStatus.textContent = near.length
			? t("editor.builder.analog_found", { n: near.length, km: B.prefs.radius })
			: t("editor.builder.none_found");
	} else {
		P.analogStatus.textContent = t("editor.builder.need_location");
	}
	syncRows(P.analogWrap, P.analogRows, analogSig.join("\n"), analogRows, (i) => hasSource(model, analogKeys[i]));
	if (B.fileReport) {
		P.fileOutput.replaceChildren(h("p", { class: "small muted" },
			t("editor.builder.file_read", { n: B.fileReport.repeaters.length, name: B.fileReport.source })));
	}

	P.snapshotNote.textContent = B.snapshot
		? t("editor.builder.s3_snapshot", { dmr: B.snapshot.dmr, analog: B.snapshot.analog })
		: "";

	// simplex: the box adds the plan, the three buttons pick its contact
	const simplexOn = hasSource(model, "simplex");
	P.simplexOn.checked = simplexOn;
	P.simplexChoice.replaceChildren(...dmr.CONTACTS.map((entry) => {
		const pressed = simplexOn && B.prefs.simplex.choice === entry.id;
		return h("button", { type: "button", class: "choice", "aria-pressed": String(pressed), onclick: () => {
			if (!simplexOn) {
				B.prefs.simplex.choice = entry.id;
				save();
				tickSimplex();
				return;
			}
			chooseSimplex(entry.id);
		} }, h("strong", {}, entry.label), h("span", { class: "small muted" }, entry.help));
	}));
	P.simplexAccess.checked = B.prefs.simplex.includeAccess;
	P.simplexAccess.disabled = !simplexOn;
	P.simplexChoice.querySelectorAll("button").forEach((node) => {
		node.disabled = false;
	});

}

// --- one tick, one change ---------------------------------------------------

// Run fn as one editor change. A source that cannot be added (the table is
// full, or the plan does not load) is rolled back, so the box springs back.
function applyChange(label, fn) {
	let result = null;
	const errorsNow = () => validate(B.api.model).filter((problem) => problem.level === "error");
	const before = errorsNow().length;
	const ok = B.api.change(label, () => {
		result = fn();
		if (result && result.ok === false) return false;
		// A codeplug may already have problems of its own; only new ones roll
		// the tick back.
		const problems = errorsNow();
		if (problems.length > before) {
			result = result || {};
			result.errors = problems.slice(0, 4).map((problem) => problemText(problem));
			return false;
		}
		return undefined;
	});
	return { ok, result };
}

// The station fields are filled the first time something is added, so a build
// has a radio name and a DMR ID without a separate press.
function withStation(model) {
	return applyStation(model, B.prefs.station);
}

function report(result, added, removed) {
	const { t } = B.api;
	const notes = result?.notes || [];
	const warnings = result?.warnings || [];
	const parts = [];
	if (added.channels) parts.push(t("editor.builder.n_channels", { n: added.channels }));
	if (added.contacts) parts.push(t("editor.builder.n_contacts", { n: added.contacts }));
	if (added.rxLists) parts.push(t("editor.builder.n_lists", { n: added.rxLists }));
	if (added.zones) parts.push(t("editor.builder.n_zones", { n: added.zones }));
	if (added.aprs) parts.push(t("editor.builder.n_aprs", { n: added.aprs }));
	const summary = parts.length ? parts.join(", ") : "";
	if (summary) B.api.say(t("editor.builder.done_tick", { what: summary }), warnings.length ? "warn" : "ok");
	else if (removed) B.api.say(t("editor.builder.removed_tick"), "info");
	if (warnings.length) {
		B.P.output.replaceChildren(h("ul", { class: "ed-builder-problems" },
			...warnings.map((warning) => h("li", { class: "muted" }, warning.message))));
	} else {
		B.P.output.replaceChildren();
	}
	B.lastNotes = notes;
}

// A tick adds; the tick that follows removes. Both go through the ledger, so
// only what this source added is taken away.
function tick(addFn, key, label) {
	const model = B.api.model;
	if (hasSource(model, key)) {
		const { ok } = applyChange(label, () => {
			removeSource(model, key);
			return { ok: true };
		});
		if (ok) {
			B.api.say(B.api.t("editor.builder.removed_tick"), "info");
			B.P.output.replaceChildren();
		}
		return;
	}
	if (!roomFor(model, key)) return;
	const { ok, result } = applyChange(label, () => {
		withStation(model);
		return addFn(model);
	});
	if (ok) report(result, result?.receipt ? countOf(result.receipt) : {}, false);
}

const countOf = (receipt) => ({
	channels: receipt.channels.length,
	contacts: receipt.contacts.length,
	rxLists: receipt.rxLists.length,
	zones: receipt.zones.length,
	aprs: receipt.aprs.length,
});

// The tables have fixed sizes; a tick that would overflow one is refused before
// the change, with a line saying which.
function roomFor(model, key) {
	const { t } = B.api;
	const checks = [
		["channels", LIMITS.channels],
		["contacts", LIMITS.contacts],
		["zones", LIMITS.zones],
		["rxLists", LIMITS.rxLists],
	];
	for (const [table, max] of checks) {
		if (model[table].length >= max) {
			B.api.say(t("editor.builder.limit", { table: t(`editor.tab.${table}`), max }), "bad");
			return false;
		}
	}
	return true;
}

function tickRepeater(repeater, on) {
	const key = `dmr:${repeater.id}`;
	tick((model) => addRepeater(model, { ...repeater, talkgroups: repeaterTalkgroups(repeater) },
		{ key, fallbackTg: B.prefs.options.fallbackTg }), key, B.api.t("editor.builder.tick_repeater", { call: repeater.callsign }));
	void on;
}

function tickAnalog(repeater) {
	const key = `analog:${analogKey(repeater)}`;
	tick((model) => addAnalog(model, repeater, { key }), key, B.api.t("editor.builder.tick_analog", { call: repeater.callsign }));
}

function tickPack(pack, on) {
	const key = `pack:${pack.id}`;
	tick((model) => {
		const result = addPack(model, pack.id, { region: B.prefs.region, country: B.prefs.country });
		// The APRS position rides with the APRS pack: it needs that channel.
		if (on && pack.id.startsWith("aprs_") && B.prefs.options.aprsConfig) {
			const aprs = addAprs(model, {
				location: B.prefs.location,
				callsign: B.prefs.station.callsign,
				ssid: B.prefs.station.ssid,
				country: B.prefs.country,
			});
			result.notes = [...result.notes, ...aprs.notes];
			result.warnings = [...result.warnings, ...aprs.warnings];
		}
		return result;
	}, key, B.api.t("editor.builder.tick_pack", { name: pack.title }));
}

function tickTalkgroup(tg, name) {
	const key = `tg:${tg}`;
	tick((model) => addTalkgroup(model, { tg, name }, { key }), key, B.api.t("editor.builder.tick_tg", { tg }));
}

function tickSimplex() {
	const key = "simplex";
	tick((model) => addSimplex(model, {
		plan: "es",
		choice: B.prefs.simplex.choice,
		includeAccess: B.prefs.simplex.includeAccess,
		country: B.prefs.country,
	}), key, B.api.t("editor.builder.tick_simplex"));
}

function tickAprs() {
	const key = "aprs";
	if (hasSource(B.api.model, key)) {
		applyChange(B.api.t("editor.builder.tick_aprs"), () => {
			removeSource(B.api.model, key);
			return { ok: true };
		});
		return;
	}
	if (!B.prefs.location || !B.prefs.station.callsign) {
		return B.api.say(B.api.t("editor.builder.aprs_needs"), "bad");
	}
	const { ok, result } = applyChange(B.api.t("editor.builder.tick_aprs"), () => addAprs(B.api.model, {
		location: B.prefs.location,
		callsign: B.prefs.station.callsign,
		ssid: B.prefs.station.ssid,
		country: B.prefs.country,
	}));
	if (ok) report(result, { aprs: 1 }, false);
	else if (result?.warnings.length) report(result, {}, false);
}

// Change of the simplex contact (TG 99, AllCall or both): take the old set out
// and put the new one in, in one change, so one Undo goes back to the old one.
function chooseSimplex(choice) {
	B.prefs.simplex.choice = choice;
	save();
	if (!hasSource(B.api.model, "simplex")) return update();
	const { ok, result } = applyChange(B.api.t("editor.builder.tick_simplex"), () => {
		removeSource(B.api.model, "simplex");
		return addSimplex(B.api.model, {
			plan: "es",
			choice,
			includeAccess: B.prefs.simplex.includeAccess,
			country: B.prefs.country,
		});
	});
	if (ok && result?.receipt) report(result, countOf(result.receipt), false);
}

function clearAll() {
	const model = B.api.model;
	const keys = sourceKeys(model);
	if (!keys.length) return;
	applyChange(B.api.t("editor.builder.clear"), () => {
		for (const key of keys) removeSource(model, key);
		return { ok: true };
	});
	B.api.say(B.api.t("editor.builder.cleared", { n: keys.length }), "info");
}

// The station fields set the codeplug's own name and DMR ID once, if empty.
function applyStationFields() {
	const model = B.api.model;
	const station = B.prefs.station;
	save();
	const emptyName = !model.general.radioName && asciiName(station.callsign, "");
	const emptyId = !model.general.dmrId && Number(station.dmrId) > 0;
	if (!emptyName && !emptyId) return;
	const { result } = applyChange(B.api.t("editor.builder.station_change"), () => {
		const applied = applyStation(model, station);
		return { ok: true, warnings: applied.warnings, notes: applied.notes };
	});
	if (result?.notes?.length) B.api.say(result.notes.map((note) => note.message).join(" "), "ok");
}

export { B as builderState };
