import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts import build_provenance as provenance


class BuildProvenanceTests(unittest.TestCase):
    def test_target_and_compiler_overrides_cannot_certify_stale_default_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            tree = Path(temporary)
            config = tree / '.cargo/config.toml'
            config.parent.mkdir()
            environment = {'CARGO_HOME': str(tree / 'cargo-home')}
            for key in provenance.OVERRIDES:
                with self.subTest(environment=key), self.assertRaisesRegex(ValueError, 'overrides'):
                    provenance.inputs(tree, ['build', '--locked', '--release'], {**environment, key: 'override'})
            for key in ('target', 'rustc', 'rustc-wrapper', 'rustc-workspace-wrapper'):
                config.write_text(f'[build]\n{key} = "override"\n')
                with self.subTest(config=key), self.assertRaisesRegex(ValueError, 'overrides'):
                    provenance.inputs(tree, ['build', '--locked', '--release'], environment)
            config.write_text('[env]\nRUSTC = { value = "override", force = true }\n')
            with self.assertRaisesRegex(ValueError, 'overrides'):
                provenance.inputs(tree, ['build', '--locked', '--release'], environment)

    def test_only_sccache_may_wrap_nightly_builds(self):
        with tempfile.TemporaryDirectory() as temporary:
            tree = Path(temporary)
            environment = {'CARGO_HOME': str(tree / 'cargo-home')}
            self.assertEqual(provenance.cargo_configs(tree, {**environment, 'RUSTC_WRAPPER': 'sccache'}), {})
            self.assertEqual(provenance.cargo_configs(tree, {**environment, 'RUSTC_WRAPPER': 'sccache', 'OMD_RELEASE_VERSION': ''}), {})
            for refused in ({'RUSTC_WRAPPER': 'ccache'}, {'RUSTC_WRAPPER': '/tmp/sccache'},
                            {'RUSTC_WRAPPER': 'sccache', 'OMD_RELEASE_VERSION': '1.2.0'},
                            {'RUSTC_WRAPPER': 'sccache', 'RUSTC_WORKSPACE_WRAPPER': 'sccache'},
                            {'RUSTC_WRAPPER': 'sccache', 'CARGO_BUILD_RUSTC_WRAPPER': 'sccache'},
                            {'OMD_SCCACHE': '1', 'RUSTC_WORKSPACE_WRAPPER': 'sccache'}):
                with self.subTest(environment=refused), self.assertRaisesRegex(ValueError, 'overrides'):
                    provenance.cargo_configs(tree, {**environment, **refused})
            config = tree / '.cargo/config.toml'
            config.parent.mkdir()
            config.write_text('[build]\nrustc-wrapper = "sccache"\n')
            with self.assertRaisesRegex(ValueError, 'overrides'):
                provenance.cargo_configs(tree, {**environment, 'RUSTC_WRAPPER': 'sccache'})

    def test_build_record_binds_inputs_unsigned_and_signed_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            identity = provenance.identity()
            inputs = {**identity, "configuration": {
                "cargo_arguments": ["build", "--locked", "--release"],
                "compiler": f"release: {identity['rust_toolchain']}\nhost: {identity['target']}",
                "environment": {"CARGO_PROFILE_RELEASE_LTO": "off"}, "cargo_configs": {}}}
            for name in provenance.BINARIES:
                (directory / name).write_text(name)
            unsigned = provenance.record_build(directory, inputs, inputs)
            self.assertEqual(provenance.verify(directory, signed=False, expected_inputs=inputs), unsigned)
            for key in identity:
                changed = copy.deepcopy(unsigned)
                changed["inputs"][key] = "different"
                (directory / provenance.RECORD).write_text(json.dumps(changed))
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "pinned inputs"):
                    provenance.verify(directory, signed=False)
            (directory / provenance.RECORD).write_text(json.dumps(unsigned))
            changed = copy.deepcopy(inputs)
            changed["configuration"]["environment"]["CARGO_PROFILE_RELEASE_LTO"] = "thin"
            with self.assertRaisesRegex(ValueError, "configuration changed"):
                provenance.verify(directory, signed=False, expected_inputs=changed)
            with self.assertRaisesRegex(ValueError, "during compilation"):
                provenance.record_build(directory, inputs, changed)
            (directory / "codex").write_text("signed codex")
            with self.assertRaisesRegex(ValueError, "bytes differ"):
                provenance.verify(directory, signed=False)
            signed = provenance.record_signing(directory, unsigned)
            self.assertEqual(signed["inputs"], inputs)
            self.assertEqual(signed["unsigned"], unsigned["unsigned"])
            self.assertEqual(provenance.verify(directory), signed)
            (directory / "omd").write_text("substituted")
            with self.assertRaisesRegex(ValueError, "bytes differ"):
                provenance.verify(directory)

