// Optional local fixtures loader. Returns personal values from
// test/fixtures.local.mjs when present, else empty arrays (CI-safe).
export async function loadPersonal() {
  try {
    const mod = await import("./fixtures.local.mjs");
    return {
      registries: Array.isArray(mod.PERSONAL_REGISTRIES) ? mod.PERSONAL_REGISTRIES : [],
      nfs: Array.isArray(mod.PERSONAL_NFS) ? mod.PERSONAL_NFS : [],
    };
  } catch {
    return { registries: [], nfs: [] };
  }
}
