export function sessionName(name = 'default') {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) throw new Error('session names are 1-32 letters, digits, - or _');
  return name.toLowerCase();
}

export function profiles(settings = {}) {
  const result = Object.create(null);
  for (const [name, profile] of Object.entries(settings)) {
    const key = sessionName(name);
    if (Object.hasOwn(result, key)) throw new Error(`conflicting session profiles: ${key}`);
    result[key] = profile;
  }
  return result;
}
