"""Whether a NixOS host needs a reboot: the booted system's kernel-side parts
compared with the current system's. Shared by nixos_upgrade and
reboot_required so both read the same parts the same way."""

from typing import List, Optional, Sequence

# The parts of a system closure whose change between the booted and the current
# generation means the new one is only fully live after a reboot.
BOOT_PARTS = ('initrd', 'kernel', 'kernel-modules', 'systemd')


def boot_parts_script() -> List[str]:
    """Shell lines printing one booted_part= and one current_part= line per boot part."""
    return [
        f'for part in {" ".join(BOOT_PARTS)}; do',
        '  echo "booted_part=$(readlink -f /run/booted-system/$part 2>/dev/null)"',
        '  echo "current_part=$(readlink -f /run/current-system/$part 2>/dev/null)"',
        'done',
    ]


def reboot_required(booted: Sequence[str], current: Sequence[str]) -> Optional[bool]:
    """Whether any booted part differs from the current one; None when the comparison could not be made."""
    if not booted or len(booted) != len(current) or not any(booted):
        return None
    return list(booted) != list(current)


def changed_parts(booted: Sequence[str], current: Sequence[str]) -> List[str]:
    """The names of the boot parts whose booted and current store paths differ."""
    return [part for part, b, c in zip(BOOT_PARTS, booted, current) if b != c]
