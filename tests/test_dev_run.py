import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from scripts import dev_run


class Store:
    def __init__(self):
        self.selections, self.calls, self.inspected = {}, [], []

    def invoke(self, manager, command, *arguments):
        self.calls.append(command)
        if command == "selection-status":
            return {"selections": [{"path": path, **entry} for path, entry in self.selections.items()]}
        if command == "inspect":
            text = (Path(arguments[0]) / "mod.json").read_text()
            if "broken" in text:
                raise ValueError("unknown field")
            self.inspected.append(Path(arguments[0]).name)
            return {"path": str(arguments[0]), "sha256": text, "manifest": {"capabilities": ["commands"]}}
        if command == "trust-all":
            for package in json.loads(arguments[1]):
                self.selections[package["path"]] = {"sha256": package["sha256"], "selected": False}
        if command == "enable":
            self.selections[str(arguments[1])]["selected"] = True
        if command == "disable":
            self.selections[str(arguments[1])]["selected"] = False


class DevRunTests(unittest.TestCase):
    def test_an_edited_mod_is_trusted_again_and_stays_on_while_a_broken_one_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            sources, location = Path(temporary) / "checkout", Path(temporary) / "store"
            for identifier in ("omd_mods", "omd_quiet", "omd_wanted", "omd_broken"):
                (sources / identifier).mkdir(parents=True)
                (sources / identifier / "mod.json").write_text('{"broken": 1}' if identifier == "omd_broken" else '{"version": 1}')
                (sources / identifier / "index.ts").write_text("")
                (sources / identifier / "mod.test.mjs").write_text("")
            store = Store()
            origin = Path(temporary) / "origin"
            origin.mkdir()
            (location / "sources").mkdir(parents=True)
            identifiers = lambda: tuple(sorted(path.name for path in sources.iterdir()))
            with patch.object(dev_run, "SOURCES", sources), patch.object(dev_run.mods_lock, "identifiers", side_effect=identifiers), \
                    patch.object(dev_run.mods_lock, "source_files", side_effect=lambda _identifier: ("mod.json", "index.ts")), \
                    patch.object(dev_run, "DEFAULT_ON", {"omd_mods"}), patch.object(dev_run, "invoke", side_effect=store.invoke), \
                    patch.object(dev_run.profiles, "invoke", side_effect=store.invoke):
                changed, refused = dev_run.sync("omd-mod", location, origin, dev_run.packages(), ["omd_wanted"])
                self.assertEqual((changed, refused), (["omd_mods", "omd_quiet", "omd_wanted"], {"omd_broken": "unknown field"}))
                selected = lambda: {Path(path).name for path, entry in store.selections.items() if entry["selected"]}
                self.assertEqual(selected(), {"omd_mods", "omd_wanted"})
                store.calls.clear()
                self.assertEqual(sorted(path.name for path in (location / "sources/omd_mods").iterdir()), ["index.ts", "mod.json"])
                self.assertFalse((location / "sources/omd_broken").exists())
                self.assertEqual(dev_run.sync("omd-mod", location, origin, [sources / "omd_mods"]), ([], {}))
                self.assertNotIn("reload", store.calls)
                (sources / "omd_mods/mod.json").write_text('{"version": 2}')
                store.inspected.clear()
                self.assertEqual(dev_run.sync("omd-mod", location, origin, [sources / "omd_mods"]), (["omd_mods"], {}))
                self.assertEqual(store.selections[str(location / "sources/omd_mods")], {"sha256": '{"version": 2}', "selected": True})
                self.assertEqual((store.inspected, store.calls[-1]), ([".omd_mods.staged"], "reload"))
                store.selections["stray"] = {"id": None, "selected": True}
                shutil.rmtree(sources / "omd_wanted")
                dev_run.forget("omd-mod", location, {path.name for path in dev_run.packages()})
                self.assertFalse((location / "sources/omd_wanted").exists())
                self.assertFalse(store.selections[str(location / "sources/omd_wanted")]["selected"])


if __name__ == "__main__":
    unittest.main()
