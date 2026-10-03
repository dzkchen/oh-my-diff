# omd_verification_gate

Development package, not installed in either profile; needs `omd_workflow`. It
registers the `omd_verification_gate@1` contract: checks, a final review and
adversarial verification by a separate agent on the exact candidate, plus checked
and reviewed contributions before integration. `seal_candidate` closes writable
delegation and integration once acceptance covers the candidate.
`/omd_verification_gate:gate` explains the contract; select it with
`omd-package contract select omd_verification_gate@1`.

Capabilities: `contracts`, `fs.read`, `services`, `tools`, `commands`.
