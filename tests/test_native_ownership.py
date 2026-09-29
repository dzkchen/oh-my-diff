from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.check_native_ownership import inspect


class NativeOwnershipTests(unittest.TestCase):
    def test_feature_named_surfaces_and_config_are_reported(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            mod = root / "runtime/omd/src/mods.rs"
            config = root / "runtime/native/src/config.rs"
            mod.parent.mkdir(parents=True)
            config.parent.mkdir(parents=True)
            mod.write_text("\n".join(
                f'pub const {surface}: &[&str] = &["{value}"];'
                for surface, value in (
                    ("MOD_HOST_FEATURES", "graph_cache_v1"),
                    ("MOD_HOST_OPERATIONS", "git.stage"),
                    ("MOD_CAPABILITIES", "review"),
                    ("MOD_EVENTS", "workflow"),
                    ("MOD_REPLACEMENT_POINTS", "checkpoint"),
                    ("MOD_MIDDLEWARE_EVENTS", "agent"),
                )
            ))
            config.write_text("struct HostConfig {\n    pub pi_user: Option<String>,\n}\n")
            findings = inspect(root)
            self.assertEqual({item["name"] for item in findings},
                             {"graph_cache_v1", "git.stage", "review", "workflow", "checkpoint", "pi_user"})


if __name__ == "__main__":
    unittest.main()
