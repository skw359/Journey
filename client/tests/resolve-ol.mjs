// Node resolve hook for tests. The app imports OpenLayers the way Vite accepts it
// ('ol/layer/Vector'); Node needs the file extension.
export async function resolve(specifier, context, nextResolve) {
  const bare = /^ol\/[\w/]+$/.test(specifier) ? `${specifier}.js` : specifier;
  return nextResolve(bare, context);
}
