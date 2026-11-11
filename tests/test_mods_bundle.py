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
    def plan(self, main, tags, features=("x_v1",), operations=RELEASED, exclude=(), manifests=None, sources=None, auto=False,
             log="", released_api="1.0.0"):
        refs = {("v1.0.0", "runtime/mods.lock.json"): lock(a="a0", b="b0") | {"mod_api": released_api},
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
                    json.dumps((manifests or {}).get(identifier, {"compatibility": {"required_features": ["x_v1"]}})))
                if identifier in (sources or {}):
                    (root / "mods/first-party" / identifier / "index.ts").write_text(sources[identifier])
            with (patch.object(mods_bundle, "ROOT", root), patch.object(mods_bundle.support, "mods_lock", return_value=main),
                  patch.object(mods_bundle.mods_lock, "build", return_value=main),
                  patch.object(mods_bundle, "at", side_effect=lambda ref, path: refs[ref, path]),
                  patch.object(mods_bundle, "published", side_effect=lambda tag: {key: value["package_sha256"]
                                                                                for key, value in tags[tag]["packages"].items()}),
                  patch.object(mods_bundle, "released_manifests", return_value=[{"compatibility": {"required_features": ["x_v1"]}}]),
                  patch.object(mods_bundle, "git", side_effect=lambda *args: {"tag": " ".join(["v1.0.0", *tags]),
                                                                             "log": log if "--first-parent" in args else ""}.get(args[0], ""))):
                return mods_bundle.automatic(exclude) if auto else mods_bundle.plan(exclude)

    def test_a_revert_ships_as_the_next_bundle_and_nothing_new_is_refused(self):
        planned = self.plan(lock(a="a0", b="b0", c="c0"), {"mods-1.0.0-1": lock(a="a1", b="b0")})
        self.assertEqual({key: planned[key] for key in ("serial", "changed", "bundle", "new", "needs_release", "needs_host")},
                         {"serial": 2, "changed": [], "bundle": ["a"], "new": ["a"], "needs_release": ["c"], "needs_host": {}})
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

    def test_a_manifest_field_the_release_rejects_holds_that_mod_back(self):
        manifests = {"b": {"compatibility": {"required_features": []}, "contributes": {"commands": []}}}
        planned = self.plan(lock(a="a1", b="b1"), {}, manifests=manifests)
        self.assertEqual(planned["needs_manifest"], {"b": ["contributes", "contributes.commands"]})
        with patch.object(mods_bundle, "plan", return_value=planned), self.assertRaisesRegex(ValueError, "manifest fields OMD 1.0.0 rejects"):
            mods_bundle.build(Path("/nonexistent"), "c" * 40)

    def test_automatic_bundles_leave_out_every_mod_the_release_cannot_run(self):
        manifests = {identifier: {"compatibility": {"required_features": []}} for identifier in "ab"}
        planned = self.plan(lock(a="a1", b="b1"), {}, features=(), manifests=manifests | {"b": {"contributes": {}}}, auto=True)
        self.assertEqual((planned["bundle"], planned["excluded"], planned["needs_manifest"]), (["a"], ["b"], {}))
        planned = self.plan(lock(a="a1", b="b1"), {}, features=(), manifests=manifests, auto=True,
                            operations=schema("0", {"0": {"type": "number"}}), sources={"b": "api.host.call('x.run', null)"})
        self.assertEqual((planned["bundle"], planned["excluded"], planned["needs_api"], planned["api_changed"]),
                         (["a"], ["b"], {}, ["x.run"]))
        with self.assertRaisesRegex(ValueError, "no longer suit OMD 1.0.0; cut a release instead: b"):
            self.plan(lock(a="a0", b="b2"), {"mods-1.0.0-1": lock(a="a0", b="b1")}, features=(), manifests={
                "a": {"compatibility": {"required_features": []}}, "b": {"contributes": {}}}, auto=True)

    def test_new_enum_values_and_list_item_fields_count_as_manifest_changes(self):
        accepted = mods_bundle.manifest_keys({"capabilities": ["store"], "services": {"imports": [{"name": "x"}]}})
        changed = mods_bundle.manifest_keys({"capabilities": ["store", "brand_new"], "services": {"imports": [{"name": "x", "y": 1}]}})
        self.assertEqual(sorted(changed - accepted), ['capabilities[]="brand_new"', "services.imports[].y"])

    def test_mods_changed_together_with_the_host_wait_for_review(self):
        log = "\0abc1234\n\nruntime/omd/src/mods.rs\nmods/first-party/b/index.ts\nruntime/mods.lock.json\n" \
              "\0def5678\n\nmods/first-party/a/index.ts\nruntime/mods.lock.json\n"
        manifests = {identifier: {"compatibility": {"required_features": []}} for identifier in "ab"}
        planned = self.plan(lock(a="a1", b="b1"), {}, features=(), manifests=manifests, log=log)
        self.assertEqual(planned["needs_runtime"], {"b": ["abc1234"]})
        with patch.object(mods_bundle, "plan", return_value=planned), self.assertRaisesRegex(ValueError, "changed with the host"):
            mods_bundle.build(Path("/nonexistent"), "c" * 40)
        planned = self.plan(lock(a="a1", b="b1"), {}, features=(), manifests=manifests, log=log, auto=True)
        self.assertEqual((planned["bundle"], planned["excluded"], planned["needs_runtime"]), (["a"], ["b"], {}))

    def test_an_automatic_run_with_nothing_to_ship_succeeds_without_a_bundle(self):
        nothing = {"omd": "1.0.0", "new": [], "excluded": [], "api_changed": []}
        with (patch.object(mods_bundle, "pinned", return_value="1.0.0"), patch.object(mods_bundle, "git", return_value="v1.0.0"),
              patch.object(mods_bundle, "automatic", return_value=nothing)):
            self.assertEqual(mods_bundle.build(Path("/nonexistent"), "c" * 40, auto=True)["published"], False)
        with patch.object(mods_bundle, "pinned", return_value="1.0.1"), patch.object(mods_bundle, "git", return_value=""):
            self.assertEqual(mods_bundle.build(Path("/nonexistent"), "c" * 40, auto=True),
                             {"published": False, "omd": "1.0.1", "reason": "the release is not tagged yet"})
        with self.assertRaisesRegex(ValueError, "different mod API"):
            self.plan(lock(a="a1", b="b0"), {}, released_api="0.9.0")
        with (patch.object(mods_bundle, "pinned", return_value="1.0.0"), patch.object(mods_bundle, "git", return_value="v1.0.0"),
              patch.object(mods_bundle, "automatic", side_effect=mods_bundle.Postponed("different mod API"))):
            self.assertEqual(mods_bundle.build(Path("/nonexistent"), "c" * 40, auto=True)["reason"], "different mod API")
        with (patch.object(mods_bundle, "pinned", return_value="1.0.0"), patch.object(mods_bundle, "git", return_value="v1.0.0"),
              patch.object(mods_bundle, "automatic", return_value=nothing | {"new": ["a"], "api_changed": ["mods/api.d.ts"]})):
            self.assertIn("api_reviewed", mods_bundle.build(Path("/nonexistent"), "c" * 40, auto=True)["reason"])


if __name__ == "__main__":
    unittest.main()
