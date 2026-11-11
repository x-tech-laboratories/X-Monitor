// Whether a NixOS host needs a reboot: the booted system's kernel-side parts compared with the current system's.
// Shared by nixos_upgrade and reboot_required so both read the same parts the same way.

// The parts of a system closure whose change between the booted and the current generation means the new one is only
// fully live after a reboot.
export const BOOT_PARTS = ["initrd", "kernel", "kernel-modules", "systemd"] as const;

// Shell lines printing one booted_part= and one current_part= line per boot part.
export function boot_parts_script(): string[] {
  return [
    `for part in ${BOOT_PARTS.join(" ")}; do`,
    '  echo "booted_part=$(readlink -f /run/booted-system/$part 2>/dev/null)"',
    '  echo "current_part=$(readlink -f /run/current-system/$part 2>/dev/null)"',
    "done",
  ];
}

// Whether any booted part differs from the current one; null when the comparison could not be made.
export function reboot_required(booted: readonly string[], current: readonly string[]): boolean | null {
  if (booted.length === 0 || booted.length !== current.length || !booted.some(Boolean)) return null;
  return booted.some((part, index) => part !== current[index]);
}

// The names of the boot parts whose booted and current store paths differ.
export function changed_parts(booted: readonly string[], current: readonly string[]): string[] {
  const length = Math.min(BOOT_PARTS.length, booted.length, current.length);
  return BOOT_PARTS.slice(0, length).filter((_, index) => booted[index] !== current[index]);
}
