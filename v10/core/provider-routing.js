function clean(value) {
  return String(value || "").trim();
}

function settings(provider = {}) {
  return provider?.settings && typeof provider.settings === "object" ? provider.settings : {};
}

function providerKey(provider = {}) {
  return clean(provider.provider_key || provider.provider_type || "unknown");
}

function runtimeOrder(provider = {}) {
  const value = Number(settings(provider).runtime_order ?? 100);
  return Number.isFinite(value) ? Math.max(1, value) : 100;
}

function qualityRole(provider = {}) {
  return clean(settings(provider).quality_role).toLowerCase();
}

function googlePriority(provider = {}) {
  const match = qualityRole(provider).match(/^google_primary_(\d+)$/u);
  return match ? Math.max(1, Number(match[1])) : runtimeOrder(provider);
}

function isGoogleModel(provider = {}) {
  const type = clean(provider.provider_type).toLowerCase();
  const model = clean(provider.model_name).toLowerCase();
  return type.includes("gemini") || /\b(gemini|gemma)/u.test(model);
}

function strictLastResort(provider = {}) {
  const role = qualityRole(provider);
  return role === "penultimate_last_resort" || role === "absolute_last_resort";
}

function stableSort(values = [], compare) {
  const result = [];
  for (const value of values) {
    let index = result.length;
    while (index > 0 && compare(value, result[index - 1]) < 0) index -= 1;
    result.splice(index, 0, value);
  }
  return result;
}

export function providerModelFamily(provider = {}) {
  const explicit = clean(settings(provider).model_family).toLowerCase();
  if (explicit) return explicit;
  const model = clean(provider.model_name).toLowerCase().replace(/\s+/g, "-");
  return model ? `model:${model}` : `provider:${providerKey(provider).toLowerCase()}`;
}

function familyDescriptors(providers = []) {
  const groups = new Map();
  for (const provider of providers || []) {
    const family = providerModelFamily(provider);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(provider);
  }
  const descriptors = [...groups.entries()].map(([family, rows]) => {
    const google = rows.some(isGoogleModel);
    const strict = rows.every(strictLastResort);
    return {
      family,
      rows,
      lane: strict ? 2 : google ? 0 : 1,
      order: google ? Math.min(...rows.map(googlePriority)) : Math.min(...rows.map(runtimeOrder)),
    };
  });
  return stableSort(descriptors, (left, right) =>
    left.lane - right.lane || left.order - right.order || left.family.localeCompare(right.family)
  );
}

function rotateFromActive(descriptors, activeFamily) {
  const active = descriptors.find((item) => item.family === activeFamily);
  if (!active) return descriptors;
  if (active.lane === 2) {
    return [active, ...descriptors.filter((item) => item !== active)];
  }
  const regular = descriptors.filter((item) => item.lane < 2);
  const strict = descriptors.filter((item) => item.lane === 2);
  const index = regular.findIndex((item) => item.family === activeFamily);
  return [...regular.slice(index), ...regular.slice(0, index), ...strict];
}

function providerRowsForFamily(descriptor, lastProviderKey) {
  return stableSort(descriptor.rows, (left, right) => {
    const leftSticky = providerKey(left) === lastProviderKey ? 0 : 1;
    const rightSticky = providerKey(right) === lastProviderKey ? 0 : 1;
    if (leftSticky !== rightSticky) return leftSticky - rightSticky;
    const leftQuality = isGoogleModel(left) ? googlePriority(left) : runtimeOrder(left);
    const rightQuality = isGoogleModel(right) ? googlePriority(right) : runtimeOrder(right);
    return leftQuality - rightQuality || providerKey(left).localeCompare(providerKey(right));
  });
}

export function stickyModelProviderOrder(providers = [], state = {}) {
  const descriptors = rotateFromActive(familyDescriptors(providers), clean(state.activeFamily).toLowerCase());
  const lastProviderKey = clean(state.lastProviderKey);
  return descriptors.flatMap((descriptor) => providerRowsForFamily(descriptor, lastProviderKey));
}

export const providerRoutingVersion = "v10_provider_sticky_model_family_v1";
