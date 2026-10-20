const omd = globalThis.__omd;
globalThis.__step = async line => {
  omd.serve(line);
  let value = null;
  try {
    value = await (omd.request.event === 'component' ? omd.component : omd.intercept)(omd.request.payload) ?? null;
    if (omd.pending()) throw new Error('swallowed_host_suspension');
  } catch (error) {
    if (error !== omd.suspension) throw error;
  }
  if (omd.calls.length < omd.request.receipts.length) throw new Error('host_call_replay_diverged');
  return JSON.stringify({ registrations: omd.registrations, state: omd.state(), ...omd.ui(), value, calls: omd.calls, host_call: omd.pending(), updates: omd.updates });
};
