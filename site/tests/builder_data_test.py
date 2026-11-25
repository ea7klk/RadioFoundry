# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The RadioFoundry Authors
# Copyright (c) 2026 The RadioFoundry-cp-builder Authors
"""The Builder tab's data generator: the text URE and HearHam publish, and the
snapshot it becomes (site/rfoundrysite/builder_data.py).

Three regressions these pin down, all of which shipped once and were invisible
because the page simply showed fewer repeaters:

  - URE's figures are text ("145.725 MHz", and in Spanish notation
    "145.712,5 MHz"); a plain float() read none of them, so every Spanish
    repeater was dropped and Spain had no UHF analog repeaters at all.
  - HearHam writes "0" for no tone, and a DCS pattern with an optional D read
    that as a code, giving hundreds of repeaters a tone of "0".
  - A tone outside 67-300 Hz is not a CTCSS tone; "00" is not one either.

    python3 site/tests/builder_data_test.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from rfoundrysite import builder_data  # noqa: E402


def ure_row(**over):
    row = {
        "name": "ED7YAE", "freq": "438.650 MHz", "shift": "-7.6 MHz", "subtono": "82.5 Hz",
        "mode": "FM", "lat": 36.72, "lng": -4.42, "provincia": "Malaga",
    }
    row.update(over)
    return row


def hearham_row(**over):
    row = {
        "callsign": "ED7YAO", "frequency": 145_725_000, "offset": -600_000,
        "encode": "82.5", "decode": "", "mode": "FM", "latitude": 36.9, "longitude": -4.5,
    }
    row.update(over)
    return row


class Measure(unittest.TestCase):
    def test_the_units_ure_publishes(self):
        self.assertEqual(builder_data.measure("145.725 MHz"), 145.725)
        self.assertEqual(builder_data.measure("438.650 MHz"), 438.65)
        self.assertEqual(builder_data.measure("- 7.6 MHz"), -7.6)
        self.assertEqual(builder_data.measure("-600 kHz"), -600.0)

    def test_spanish_decimal_comma(self):
        # the dot separates MHz from a kHz part that carries a decimal comma
        self.assertEqual(builder_data.measure("145.712,5 MHz"), 145.7125)
        self.assertEqual(builder_data.measure("438.037,5 MHz"), 438.0375)

    def test_nothing(self):
        self.assertIsNone(builder_data.measure(""))
        self.assertIsNone(builder_data.measure(None))
        self.assertIsNone(builder_data.measure("abc"))

    def test_shifts_in_either_unit(self):
        self.assertEqual(builder_data.parse_ure_shift("-600 kHz"), -0.6)
        self.assertEqual(builder_data.parse_ure_shift("- 600 kHz"), -0.6)
        self.assertEqual(builder_data.parse_ure_shift("-7.6 MHz"), -7.6)
        self.assertEqual(builder_data.parse_ure_shift("-7.6MHz"), -7.6)
        self.assertEqual(builder_data.parse_ure_shift("-600"), -0.6)
        self.assertEqual(builder_data.parse_ure_shift(""), 0.0)


class UreRows(unittest.TestCase):
    def test_a_row_becomes_a_repeater(self):
        out = builder_data.normalize_ure(ure_row(), "repe432")
        self.assertIsNotNone(out)
        self.assertEqual((out["down"], out["up"]), (438.65, 431.05))
        self.assertEqual((out["tone"], out["source"], out["band"]), ("82.5", "u", "repe432"))

    def test_a_decimal_comma_frequency_survives(self):
        out = builder_data.normalize_ure(ure_row(freq="145.712,5 MHz", shift="- 600 kHz"), "repe144")
        self.assertEqual((out["down"], out["up"]), (145.7125, 145.1125))

    def test_a_row_without_a_usable_frequency_is_dropped(self):
        self.assertIsNone(builder_data.normalize_ure(ure_row(freq="7.6 MHz"), "repe432"))
        self.assertIsNone(builder_data.normalize_ure(ure_row(freq=""), "repe432"))

    def test_digital_and_packet_modes_are_dropped(self):
        for mode in ("D-Star", "DMR", "C4FM", "APRS"):
            self.assertIsNone(builder_data.normalize_ure(ure_row(mode=mode), "repe432"), mode)
        self.assertIsNotNone(builder_data.normalize_ure(ure_row(mode="FM Echolink"), "repe432"))


class Tones(unittest.TestCase):
    def test_no_tone(self):
        for value in ("", None, "0", "00", "000", "NONE", "OFF", "CSQ", "-"):
            self.assertEqual(builder_data.clean_tone(value), "", value)

    def test_ctcss(self):
        self.assertEqual(builder_data.clean_tone("88.5"), "88.5")
        self.assertEqual(builder_data.clean_tone("77"), "77")
        self.assertEqual(builder_data.clean_tone("67"), "67")
        self.assertEqual(builder_data.clean_tone("300"), "300")

    def test_a_decimal_comma_is_the_same_tone(self):
        self.assertEqual(builder_data.clean_tone("82,5"), "82.5")

    def test_out_of_range_is_not_a_tone(self):
        self.assertEqual(builder_data.clean_tone("301"), "")
        self.assertEqual(builder_data.clean_tone("12"), "")

    def test_dcs_needs_its_d(self):
        self.assertEqual(builder_data.clean_tone("D023N"), "D023N")
        self.assertEqual(builder_data.clean_tone("D023I"), "D023I")


class HearHamRows(unittest.TestCase):
    def test_frequency_and_offset_become_rx_and_tx(self):
        out = builder_data.normalize_hearham(hearham_row())
        self.assertEqual((out["down"], out["up"]), (145.725, 145.125))
        self.assertEqual(out["tone"], "82.5")

    def test_only_a_mode_with_fm_is_an_analog_channel(self):
        self.assertIsNone(builder_data.normalize_hearham(hearham_row(mode="DMR")))
        self.assertIsNone(builder_data.normalize_hearham(hearham_row(mode="DMR    ")))
        self.assertIsNotNone(builder_data.normalize_hearham(hearham_row(mode="FM    ")))
        self.assertIsNotNone(builder_data.normalize_hearham(hearham_row(mode="YSF/FM")))

    def test_no_tone_stays_empty(self):
        self.assertEqual(builder_data.normalize_hearham(hearham_row(encode="0"))["tone"], "")


class Merge(unittest.TestCase):
    def test_ure_wins_and_a_hearham_tone_is_lent(self):
        ure = {"repe144": {"items": [ure_row(name="ED7YAO", freq="145.725 MHz", shift="-600 kHz", subtono="")]},
               "repe432": {"items": []}}
        rows = builder_data.analog_repeaters([hearham_row(encode="88.5")], ure)
        self.assertEqual(len(rows), 1, "the same repeater from both sources is one row")
        self.assertEqual(rows[0]["source"], "u", "URE is the coordinator's own list")
        self.assertEqual(rows[0]["tone"], "88.5", "a tone only HearHam has is filled in")

    def test_both_bands_are_in_the_snapshot(self):
        ure = {"repe144": {"items": [ure_row(name="ED1YAB", freq="145.725 MHz", shift="-600 kHz")]},
               "repe432": {"items": [ure_row(name="ED7YAE", freq="438.650 MHz", shift="-7.6 MHz")]}}
        rows = builder_data.analog_repeaters([], ure)
        self.assertEqual({r["band"] for r in rows}, {"repe144", "repe432"})
        self.assertEqual(sum(1 for r in rows if r["down"] >= 300), 1, "the UHF row is there")


if __name__ == "__main__":
    unittest.main()
