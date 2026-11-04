const omd = globalThis.__omd;
globalThis.__step = async line => {
  omd.serve(line);
  const value = await (omd.request.event === 'component' ? omd.component : omd.intercept)(omd.request.payload) ?? null;
  if (omd.calls.length < omd.request.receipts.length) throw new Error('host_call_replay_diverged');
  return JSON.stringify({ registrations: omd.registrations, state: omd.state(), ...omd.ui(), value, calls: omd.calls, updates: omd.updates });
};
