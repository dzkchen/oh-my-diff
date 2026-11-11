import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import mods_bundle


def lock(**packages):
    return {"mod_api": "1.0.0", "packages": {identifier: {"package_sha256": sha256} for identifier, sha256 in packages.items()}}


def schema(argument, defs):
    return {"operations": {"x.run": {"arguments": {"$ref": f"#/$defs/{argument}"}}}, "$defs": defs}


RELEASED = schema("0", {"0": {"type": "string"}})


class Plan(unittest.TestCase):
    def plan(self, main, tags, features=("x_v1",), operations=RELEASED, exclude=()):
        refs = {("v1.0.0", "runtime/mods.lock.json"): lock(a="a0", b="b0"),
                ("v1.0.0", "mods/conformance/compatibility.json"): {"host": {"features": list(features)}},
                ("v1.0.0", mods_bundle.OPERATIONS): RELEASED}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "extensions").mkdir()
            (root / "extensions/index.json").write_text(json.dumps({"release_pin": {"omd": "1.0.0"}}))
            (root / mods_bundle.OPERATIONS).parent.mkdir(parents=True)
            (root / mods_bundle.OPERATIONS).write_text(json.dumps(operations))
            for identifier in main["packages"]:
                (root / "mods/first-party" / identifier).mkdir(parents=True)
                (root / "mods/first-party" / identifier / "mod.json").write_text(
                    json.dumps({"compatibility": {"required_features": ["x_v1"]}}))
            with (patch.object(mods_bundle, "ROOT", root), patch.object(mods_bundle.support, "mods_lock", return_value=main),
                  patch.object(mods_bundle.mods_lock, "build", return_value=main),
                  patch.object(mods_bundle, "at", side_effect=lambda ref, path: refs[ref, path]),
                  patch.object(mods_bundle, "published", side_effect=lambda tag: {key: value["package_sha256"]
                                                                                for key, value in tags[tag]["packages"].items()}),
                  patch.object(mods_bundle, "git", side_effect=lambda *args: " ".join(tags) if args[0] == "tag" else "")):
                return mods_bundle.plan(exclude)

    def test_a_revert_ships_as_the_next_bundle_and_nothing_new_is_refused(self):
        planned = self.plan(lock(a="a0", b="b0", c="c0"), {"mods-1.0.0-1": lock(a="a1", b="b0")})
        self.assertEqual({key: planned[key] for key in ("serial", "changed", "bundle", "new", "added", "needs_release", "needs_host")},
                         {"serial": 2, "changed": [], "bundle": ["a", "c"], "new": ["a", "c"], "added": ["c"], "needs_release": [],
                          "needs_host": {}})
        planned = self.plan(lock(a="a0", b="b0", c="c0"), {"mods-1.0.0-1": lock(a="a0", b="b0", c="c0")})
        self.assertEqual((planned["bundle"], planned["new"], planned["added"]), (["c"], [], ["c"]))
        planned = self.plan(lock(a="a0", b="b0", c="c0"), {}, features=())
        self.assertEqual((planned["bundle"], planned["added"], planned["needs_release"]), ([], [], ["c"]))
        planned = self.plan(lock(a="a0", b="b0"), {"mods-1.0.0-1": lock(a="a1", b="b0"), "mods-1.0.0-2": lock(a="a0", b="b0")})
        self.assertEqual((planned["serial"], planned["bundle"], planned["new"]), (3, ["a"], []))
        with (patch.object(mods_bundle, "plan", return_value=planned),
              self.assertRaisesRegex(ValueError, "no first-party mod changed since OMD 1.0.0 or its last mod bundle")):
            mods_bundle.build(Path("/nonexistent"), "c" * 40)

    def test_a_shipped_mod_removed_from_main_needs_a_release(self):
        with self.assertRaisesRegex(ValueError, "removed from main; cut a release instead: b"):
            self.plan(lock(a="a0"), {"mods-1.0.0-1": lock(a="a0", b="b1")})

    def test_a_mod_needing_a_newer_host_is_refused(self):
        planned = self.plan(lock(a="a0", b="b1"), {}, features=())
        self.assertEqual((planned["new"], planned["needs_host"]), (["b"], {"b": ["x_v1"]}))
        with patch.object(mods_bundle, "plan", return_value=planned), self.assertRaisesRegex(ValueError, "need host features"):
            mods_bundle.build(Path("/nonexistent"), "c" * 40)

    def test_a_changed_operation_needs_review_and_excluded_mods_stay_out(self):
        self.assertEqual(self.plan(lock(a="a1", b="b0"), {}, operations=schema("7", {"7": {"type": "string"}}))["api_changed"], [])
        self.assertEqual(self.plan(lock(a="a1", b="b1"), {"mods-1.0.0-1": lock(a="a1")}, exclude=["b"])["bundle"], ["a"])
        planned = self.plan(lock(a="a1", b="b1"), {}, operations=schema("0", {"0": {"type": "number"}}), exclude=["b"])
        self.assertEqual((planned["bundle"], planned["excluded"], planned["api_changed"]), (["a"], ["b"], ["x.run"]))
        with patch.object(mods_bundle, "plan", return_value=planned), self.assertRaisesRegex(ValueError, "pass --api-reviewed"):
            mods_bundle.build(Path("/nonexistent"), "c" * 40)
        with self.assertRaisesRegex(ValueError, "cannot be excluded; revert them instead: a"):
            self.plan(lock(a="a1", b="b0"), {"mods-1.0.0-1": lock(a="a2", b="b0")}, exclude=["a"])


if __name__ == "__main__":
    unittest.main()
