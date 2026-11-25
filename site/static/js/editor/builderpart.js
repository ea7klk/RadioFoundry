// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Copyright (c) 2026 The RadioFoundry-cp-builder Authors
// The Builder tab: channels, contacts and zones built from a location. It asks
// for a place, offers the standard analog packs, the DMR repeaters and their
// static talkgroups, a searchable table of every Brandmeister talkgroup, the
// analog repeaters and the DMR simplex plan, then adds the lot to the open
// codeplug as one undoable change.
//
// Everything runs in the page. The repeater and talkgroup lists are the
// snapshots in codeplug/builder/data/ (Brandmeister and HearHam send no CORS
// headers, so a page cannot read them); place search and geolocation are live.
// The choices are kept in this browser, never sent anywhere.

import { register } from "./extensions.js";
import { h, button } from "../flasher/dom.js";
import { asciiName, applyPlan, problemText } from "../codeplug/builder/plan.js";
import * as geo from "../codeplug/builder/geo.js";
import * as packs from "../codeplug/builder/packs.js";
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
	packs: [],		// pack ids
	radius: 50,
	band: "all",		// analog band filter
	dmr: [],		// chosen repeater ids
	analog: [],		// chosen analog keys
	contacts: [],		// [{tg, name}] from the talkgroup table
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
		B.prefs.packs = B.prefs.packs.filter((id) => packs.PACK_BY_ID.has(id));
		changed();
	} });
	P.region = h("select", { onchange: () => {
		B.prefs.region = P.region.value;
		changed();
	} });
	P.packList = h("div", { class: "ed-builder-packs" });
	P.aprs = h("input", { type: "checkbox", onchange: () => {
		B.prefs.options.aprsConfig = P.aprs.checked;
		changed();
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
		for (const row of visibleTalkgroups()) {
			const key = row[0];
			const at = B.prefs.contacts.findIndex((c) => c.tg === key);
			if (P.tgAll.checked && at < 0) B.prefs.contacts.push({ tg: key, name: row[1] });
			if (!P.tgAll.checked && at >= 0) B.prefs.contacts.splice(at, 1);
		}
		changed();
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
	P.band = h("select", { onchange: () => {
		B.prefs.band = P.band.value;
		changed();
	} });
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
		B.prefs.analog = B.prefs.analog.filter((key) => parsed.repeaters.some((r) => analogKey(r) === key));
		changed();
	} });

	// 6. DMR simplex
	P.simplexOn = h("input", { type: "checkbox", checked: B.prefs.simplex.enabled, onchange: () => {
		B.prefs.simplex.enabled = P.simplexOn.checked;
		changed();
	} });
	P.simplexChoice = h("div", { class: "choice-grid ed-builder-simplex" });
	P.simplexAccess = h("input", { type: "checkbox", checked: B.prefs.simplex.includeAccess, onchange: () => {
		B.prefs.simplex.includeAccess = P.simplexAccess.checked;
		changed();
	} });

	// 7. Station
	P.callsign = h("input", { type: "text", maxlength: "12", value: B.prefs.station.callsign, oninput: () => {
		B.prefs.station.callsign = P.callsign.value.toUpperCase().replace(/[^A-Z0-9/]/g, "");
		P.callsign.value = B.prefs.station.callsign;
		changed();
	} });
	P.dmrId = h("input", { type: "text", inputmode: "numeric", maxlength: "8", value: B.prefs.station.dmrId,
		oninput: () => {
			B.prefs.station.dmrId = P.dmrId.value.replace(/[^0-9]/g, "");
			P.dmrId.value = B.prefs.station.dmrId;
			changed();
		} });

	// Output
	P.build = button(t("editor.builder.add"), () => run(), { primary: true });
	P.clear = button(t("editor.builder.clear"), () => {
		B.prefs = { ...DEFAULTS, station: { ...DEFAULTS.station }, options: { ...DEFAULTS.options }, simplex: { ...DEFAULTS.simplex } };
		B.built = null;
		syncInputs();
		changed();
	}, { quiet: true });
	P.status = h("p", { class: "small muted" });
	P.output = h("div", { class: "ed-builder-output" });

	P.el = h("div", { class: "rid ed-builder" },
		h("p", { class: "lead" }, t("editor.builder.lead")),
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
			h("div", { class: "table-wrap ed-builder-table" },
				h("table", { class: "grid" },
					h("thead", {}, h("tr", {},
						h("th", { class: "grid-check" }, ""), h("th", {}, t("editor.builder.col_call")),
						h("th", {}, t("editor.builder.col_dmx")), h("th", {}, t("editor.builder.col_place")),
						h("th", {}, t("editor.builder.col_tg")))),
					P.dmrRows)),
			h("label", { class: "rid-check" }, P.fallback, h("span", {}, t("editor.builder.fallback"))),
			h("p", { class: "small muted" }, t("editor.builder.s3_note")),
			P.snapshotNote),
		step(4, t("editor.builder.s4"),
			card(field(t("editor.builder.tg_search"), P.tgQuery), field(t("editor.builder.continent"), P.tgContinent),
				field(t("editor.builder.country"), P.tgCountry)),
			h("div", { class: "rid-row" }, P.tgSearch, P.tgCount),
			P.tgStatus,
			h("div", { class: "table-wrap ed-builder-table" },
				h("table", { class: "grid" },
					h("thead", {}, h("tr", {},
						h("th", { class: "grid-check" }, P.tgAll), h("th", {}, t("editor.builder.col_tg_id")),
						h("th", {}, t("editor.builder.col_name")), h("th", {}, t("editor.builder.col_country")))),
					P.tgRows)),
			P.tgChips,
			h("p", { class: "small muted" }, t("editor.builder.s4_note"))),
		step(5, t("editor.builder.s5"),
			h("div", { class: "rid-row" }, field(t("editor.builder.band"), P.band),
				field(t("editor.builder.radius"), P.analogRadius), P.analogRadiusOut),
			P.analogStatus,
			h("div", { class: "table-wrap ed-builder-table" },
				h("table", { class: "grid" },
					h("thead", {}, h("tr", {},
						h("th", { class: "grid-check" }, ""), h("th", {}, t("editor.builder.col_call")),
						h("th", {}, t("editor.builder.col_rx")), h("th", {}, t("editor.builder.col_tone")),
						h("th", {}, t("editor.builder.col_place")), h("th", {}, t("editor.builder.col_source")))),
					P.analogRows)),
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
		h("div", { class: "rid-output" }, h("div", { class: "rid-row" }, P.build, P.clear), P.status, P.output),
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
		...["R1", "R2", "R3"].map((region) => h("optgroup", { label: packs.REGIONS[region].label },
			...packs.COUNTRIES.filter(([, , ccRegion]) => ccRegion === region)
				.map(([cc, name]) => h("option", { value: cc }, `${name} (${cc})`)))));
	P.country.value = packs.COUNTRY_BY_CC.has(current) ? current : "";
	P.region.replaceChildren(...Object.entries(packs.REGIONS).map(([id, region]) =>
		h("option", { value: id }, region.label)));
	P.region.value = B.prefs.region;
}

function setLocation(location) {
	B.prefs.location = { lat: Math.round(location.lat * 1e6) / 1e6, lon: Math.round(location.lon * 1e6) / 1e6, label: location.label };
	if (!B.prefs.packs.length) B.prefs.packs = packs.defaultPacks(B.prefs.region, B.prefs.country);
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

function visibleTalkgroups() {
	const needle = asciiName(B.prefs.tgQuery, "").toLowerCase();
	const digits = B.prefs.tgQuery.replace(/[^0-9]/g, "");
	let rows = B.talkgroups || [];
	if (needle) {
		rows = rows.filter((row) =>
			row[1].toLowerCase().includes(needle) || (digits && String(row[0]).includes(digits)));
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

	P.location.replaceChildren(location
		? h("span", {}, `${location.label} · ${geo.formatLatLon(location.lat, location.lon, 4)} · ${geo.latLonToLocator(location.lat, location.lon, 6)}`)
		: h("span", {}, t("editor.builder.no_location")));

	// packs
	const rows = packs.PACKS.map((pack) => {
		const applies = packs.packApplies(pack, B.prefs.region, B.prefs.country);
		const box = h("input", { type: "checkbox", checked: B.prefs.packs.includes(pack.id), onchange: () => {
			const at = B.prefs.packs.indexOf(pack.id);
			if (at < 0) B.prefs.packs.push(pack.id);
			else B.prefs.packs.splice(at, 1);
			changed();
		} });
		const count = pack.channels({ region: B.prefs.region, country: B.prefs.country }).length;
		return h("label", { class: "rid-check ed-builder-pack" }, box,
			h("span", {},
				h("strong", {}, pack.title), " ",
				h("span", { class: "badge" }, t("editor.builder.pack_channels", { n: count })),
				applies ? null : h("span", { class: "badge" }, t("editor.builder.other_region")),
				h("span", { class: "small muted ed-builder-pack-summary" }, pack.summary)));
	});
	P.packList.replaceChildren(...rows);
	const aprsPack = B.prefs.packs.some((id) => id.startsWith("aprs_"));
	P.aprs.disabled = !aprsPack;
	P.ssid.disabled = !aprsPack || !B.prefs.options.aprsConfig;
	P.packsNote.textContent = aprsPack ? t("editor.builder.aprs_note") : t("editor.builder.aprs_note_off");

	// DMR repeaters
	const dmrRows = [];
	if (location && B.dmrRepeaters) {
		const near = B.dmrRepeaters
			.filter((repeater) => repeater.lat !== null && repeater.lon !== null)
			.map((repeater) => ({ ...repeater, km: geo.distanceKm(location.lat, location.lon, repeater.lat, repeater.lon) }))
			.filter((repeater) => repeater.km <= B.prefs.radius)
			.sort((a, b) => a.km - b.km)
			.slice(0, 300);
		for (const repeater of near) {
			const chosen = B.prefs.dmr.includes(repeater.id);
			const own = repeaterTalkgroups(repeater);
			const first = own[0];
			const tgText = first
				? (first.national
					? t("editor.builder.tg_national", { tg: first.tg, name: first.name })
					: `${first.tg}${first.slot ? ` · TS${first.slot}` : ""}`) + (own.length > 1 ? ` +${own.length - 1}` : "")
				: (B.prefs.options.fallbackTg ? t("editor.builder.tg_fallback") : "—");
			dmrRows.push(h("tr", {},
				h("td", { class: "grid-check" }, h("input", { type: "checkbox", checked: chosen, onchange: (event) => {
					const at = B.prefs.dmr.indexOf(repeater.id);
					if (event.target.checked && at < 0) B.prefs.dmr.push(repeater.id);
					if (!event.target.checked && at >= 0) B.prefs.dmr.splice(at, 1);
					changed();
				} })),
				h("td", {}, repeater.callsign),
				h("td", { class: "c-num" }, `${geo.formatMHz(repeater.downlink_mhz * 1e6)} / ${geo.formatMHz(repeater.uplink_mhz * 1e6)}`),
				h("td", {}, `${repeater.city || "—"} · ${geo.formatKm(repeater.km)}`),
				h("td", {}, tgText)));
		}
		P.dmrStatus.textContent = near.length
			? t("editor.builder.dmr_found", { n: near.length, km: B.prefs.radius })
			: t("editor.builder.none_found");
	} else {
		P.dmrStatus.textContent = t("editor.builder.need_location");
	}
	P.dmrRows.replaceChildren(...dmrRows);

	// talkgroups
	const all = B.talkgroups || [];
	P.tgContinent.replaceChildren(h("option", { value: "all" }, t("editor.builder.all_continents")),
		...dmr.CONTINENTS.map(([id, label]) => h("option", { value: id }, label)));
	P.tgContinent.value = B.prefs.tgContinent;
	const countries = new Map();
	for (const row of all) {
		if (row[3] && (B.prefs.tgContinent === "all" || row[2] === B.prefs.tgContinent))
			countries.set(row[3], (countries.get(row[3]) || 0) + 1);
	}
	P.tgCountry.replaceChildren(h("option", { value: "" }, t("editor.builder.all_countries")),
		...[...countries.entries()].sort((a, b) => a[0].localeCompare(b[0]))
			.map(([cc, n]) => h("option", { value: cc }, `${cc} (${n})`)));
	P.tgCountry.value = countries.has(B.prefs.tgCountry) ? B.prefs.tgCountry : "";
	const visible = visibleTalkgroups();
	const shown = visible.slice(0, 250);
	P.tgRows.replaceChildren(...shown.map((row) => {
		const [tgId, name, , cc] = row;
		const chosen = B.prefs.contacts.some((c) => c.tg === tgId);
		return h("tr", {},
			h("td", { class: "grid-check" }, h("input", { type: "checkbox", checked: chosen, onchange: (event) => {
				const at = B.prefs.contacts.findIndex((c) => c.tg === tgId);
				if (event.target.checked && at < 0) B.prefs.contacts.push({ tg: tgId, name });
				if (!event.target.checked && at >= 0) B.prefs.contacts.splice(at, 1);
				changed();
			} })),
			h("td", { class: "c-num" }, String(tgId)),
			h("td", {}, name),
			h("td", {}, cc || dmr.CONTINENT_LABEL[row[2]] || ""));
	}));
	P.tgAll.checked = shown.length > 0 && shown.every((row) => B.prefs.contacts.some((c) => c.tg === row[0]));
	P.tgAll.indeterminate = !P.tgAll.checked && shown.some((row) => B.prefs.contacts.some((c) => c.tg === row[0]));
	P.tgStatus.textContent = visible.length
		? t("editor.builder.tg_matched", { n: visible.length, shown: shown.length })
		: t("editor.builder.tg_none");
	P.tgCount.textContent = t("editor.builder.selected_n", { n: B.prefs.contacts.length });
	P.tgChips.replaceChildren(...B.prefs.contacts.slice().sort((a, b) => a.tg - b.tg).map((contact) =>
		h("li", {}, h("b", {}, String(contact.tg)), " ", contact.name,
			h("button", { type: "button", "aria-label": t("editor.builder.remove", { name: contact.name }), onclick: () => {
				B.prefs.contacts = B.prefs.contacts.filter((c) => c.tg !== contact.tg);
				changed();
			} }, "×"))));

	P.snapshotNote.textContent = B.snapshot
		? t("editor.builder.s3_snapshot", { dmr: B.snapshot.dmr, analog: B.snapshot.analog })
		: "";

	// analog repeaters
	const pool = [...(B.analogRepeaters || []), ...B.file];
	const analogRows = [];
	if (location) {
		const near = analog.nearby(pool, location.lat, location.lon, B.prefs.radius, { band: B.prefs.band, limit: 300 });
		for (const repeater of near) {
			const key = analogKey(repeater);
			const chosen = B.prefs.analog.includes(key);
			analogRows.push(h("tr", {},
				h("td", { class: "grid-check" }, h("input", { type: "checkbox", checked: chosen, onchange: (event) => {
					const at = B.prefs.analog.indexOf(key);
					if (event.target.checked && at < 0) B.prefs.analog.push(key);
					if (!event.target.checked && at >= 0) B.prefs.analog.splice(at, 1);
					changed();
				} })),
				h("td", {}, repeater.callsign),
				h("td", { class: "c-num" }, `${geo.formatMHz(repeater.downlink_mhz * 1e6)} / ${geo.formatMHz(repeater.uplink_mhz * 1e6)}`),
				h("td", {}, repeater.tx_tone || t("editor.builder.no_tone")),
				h("td", {}, `${repeater.city || "—"} · ${geo.formatKm(repeater.distance_km)} · ${analog.bandOf(repeater.downlink_mhz).toUpperCase()}`),
				h("td", {}, analog.SOURCE_NAMES[repeater.source] || repeater.source)));
		}
		P.analogStatus.textContent = near.length
			? t("editor.builder.analog_found", { n: near.length, km: B.prefs.radius })
			: t("editor.builder.none_found");
	} else {
		P.analogStatus.textContent = t("editor.builder.need_location");
	}
	P.analogRows.replaceChildren(...analogRows);
	if (B.fileReport) {
		P.fileOutput.replaceChildren(h("p", { class: "small muted" },
			t("editor.builder.file_read", { n: B.fileReport.repeaters.length, name: B.fileReport.source })));
	}

	// simplex
	P.simplexChoice.replaceChildren(...dmr.CONTACTS.map((entry) => {
		const pressed = B.prefs.simplex.choice === entry.id;
		return h("button", { type: "button", class: "choice", "aria-pressed": String(pressed), onclick: () => {
			B.prefs.simplex.choice = entry.id;
			changed();
		} }, h("strong", {}, entry.label), h("span", { class: "small muted" }, entry.help));
	}));
	P.simplexChoice.querySelectorAll(".choice").forEach((node, index) => {
		node.setAttribute("aria-pressed", String(dmr.CONTACTS[index].id === B.prefs.simplex.choice));
	});
	P.simplexAccess.disabled = !B.prefs.simplex.enabled;
	P.simplexChoice.querySelectorAll("button").forEach((node) => {
		node.disabled = !B.prefs.simplex.enabled;
	});

	// output
	P.build.disabled = !location;
	if (B.built) renderOutput();
}

function renderOutput() {
	const { t } = B.api;
	const result = B.built;
	const body = [];
	if (result.errors.length) {
		body.push(h("p", { class: "rid-summary bad" }, t("editor.builder.not_added")));
		body.push(h("ul", { class: "ed-builder-problems" },
			...result.errors.map((error) => h("li", { class: "ed-err" }, error.message))));
	} else {
		body.push(h("p", { class: "rid-summary" }, t("editor.builder.added", {
			channels: result.added.channels, contacts: result.added.contacts,
			lists: result.added.rxLists, zones: result.added.zones,
		})));
	}
	if (result.notes.length) {
		body.push(h("ul", { class: "ed-builder-problems" }, ...result.notes.map((note) => h("li", {}, note.message))));
	}
	if (result.warnings.length) {
		body.push(h("ul", { class: "ed-builder-problems" }, ...result.warnings.map((warning) => h("li", { class: "muted" }, warning.message))));
	}
	if (!result.errors.length) {
		body.push(h("div", { class: "rid-row" }, button(t("editor.builder.go_channels"), () => B.api.show("channels"), { quiet: true })));
	}
	B.P.output.replaceChildren(...body);
}

// --- building ---------------------------------------------------------------

function run() {
	const { api } = B;
	const { t } = api;
	const { location } = B.prefs;
	if (!location) return api.say(t("editor.builder.bad_coords"), "bad");
	// The repeater snapshot keeps talkgroup ids only (the names live once, in the
	// talkgroup table), so they are filled in here for the contact names.
	const dmrChosen = (B.dmrRepeaters || [])
		.filter((repeater) => B.prefs.dmr.includes(repeater.id))
		.map((repeater) => ({ ...repeater, talkgroups: repeaterTalkgroups(repeater) }));
	const analogPool = [...(B.analogRepeaters || []), ...B.file];
	const analogChosen = B.prefs.analog
		.map((key) => analogPool.find((repeater) => analogKey(repeater) === key))
		.filter(Boolean);
	let result = null;
	const ok = api.change(t("editor.builder.undo"), () => {
		result = applyPlan(api.model, {
			location,
			country: B.prefs.country,
			region: B.prefs.region,
			station: B.prefs.station,
			packs: B.prefs.packs,
			dmr: dmrChosen,
			analog: analogChosen,
			contacts: B.prefs.contacts,
			dmrSimplex: { ...B.prefs.simplex, plan: "es" },
			options: { ...B.prefs.options, aprsSsid: B.prefs.station.ssid },
		});
		if (!result.ok) return false;
		const problems = validate(api.model).filter((problem) => problem.level === "error");
		if (problems.length) {
			result.errors.push(...problems.slice(0, 8).map((problem) => ({ code: problem.code, message: problemText(problem) })));
			result.ok = false;
			return false;
		}
		return undefined;
	});
	B.built = result;
	if (!ok) {
		renderOutput();
		return api.say(t("editor.builder.not_added_short"), "bad");
	}
	renderOutput();
	const parts = [
		result.added.channels ? t("editor.builder.n_channels", { n: result.added.channels }) : null,
		result.added.contacts ? t("editor.builder.n_contacts", { n: result.added.contacts }) : null,
		result.added.zones ? t("editor.builder.n_zones", { n: result.added.zones }) : null,
	].filter(Boolean);
	api.say(t("editor.builder.done", { what: parts.join(", ") }), result.warnings.length ? "warn" : "ok");
}

export { B as builderState };
